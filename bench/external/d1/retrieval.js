/**
 * D1 · 文档检索（open-book 口径）：从整篇 10-K 里找出与问题相关的段落。
 *
 * 为什么这一步是 D1 的关键：oracle 口径直接把论文标注的支撑段落喂给模型，
 * 而真实场景里模型必须先自己找到那一页。FinanceBench 论文的核心结论正是
 * "向量库 RAG 在真实财报上表现很差"——所以这一环必须单独量化，
 * 否则"分数掉了"到底是检索没找到、还是模型读不懂，说不清。
 *
 * 实现：BM25（纯 JS，无依赖）+ 结构感知切块（保持"标签+数字"的行块不被切断）。
 * 产出两个指标：
 *  - 检索命中：被选中的 chunk 里是否包含标准证据段落（拿论文给的 evidence 做真值）
 *  - 覆盖率：证据段落有多少字符被选中
 */

const STOP = new Set(['the', 'and', 'for', 'was', 'were', 'are', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'not', 'but', 'its', 'our', 'you', 'your', 'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'did', 'does', 'do', 'is', 'of', 'in', 'to', 'on', 'at', 'by', 'as', 'or', 'be', 'an', 'a', 'it', 'we', 'they', 'their', 'there', 'than', 'then', 'into', 'over', 'per', 'vs', 's'])

/** 中英混排的分词：英文按词、数字按整串、中文按字 */
function tokenize(s) {
  const out = []
  for (const m of String(s || '').toLowerCase().matchAll(/[a-z][a-z'-]{1,}|[\u4e00-\u9fff]|\d[\d,]*(?:\.\d+)?%?/g)) {
    const t = m[0]
    if (/^[a-z]/.test(t)) { if (!STOP.has(t) && t.length > 1) out.push(t) } else out.push(t.replace(/,/g, ''))
  }
  return out
}

/**
 * 结构感知切块：按行累积到 size 字符切一块；表格行（含数字的行）优先成组保留。
 * overlap 用于避免答案刚好跨在切缝上。
 */
function chunk(text, { size = 1400, overlap = 200 } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
  const chunks = []
  let buf = []
  let len = 0
  const flush = () => {
    if (!buf.length) return
    const content = buf.join('\n')
    chunks.push(content)
    // 重叠：从尾部保留 overlap 字符对应的若干行
    const tail = []
    let tl = 0
    for (let i = buf.length - 1; i >= 0 && tl < overlap; i--) { tail.unshift(buf[i]); tl += buf[i].length + 1 }
    buf = tail
    len = tl
  }
  for (const l of lines) {
    buf.push(l)
    len += l.length + 1
    if (len >= size) flush()
  }
  if (buf.length) chunks.push(buf.join('\n'))
  return chunks
}

/** BM25 索引与打分 */
class BM25 {
  constructor(chunks, { k1 = 1.5, b = 0.75 } = {}) {
    this.chunks = chunks
    this.k1 = k1
    this.b = b
    this.df = new Map()
    this.tf = []
    this.len = []
    let total = 0
    for (const c of chunks) {
      const toks = tokenize(c)
      const f = new Map()
      for (const t of toks) f.set(t, (f.get(t) || 0) + 1)
      this.tf.push(f)
      this.len.push(toks.length)
      total += toks.length
      for (const t of f.keys()) this.df.set(t, (this.df.get(t) || 0) + 1)
    }
    this.avgLen = total / Math.max(1, chunks.length)
    this.n = chunks.length
  }

  score(query) {
    const q = [...new Set(tokenize(query))]
    const out = new Array(this.n).fill(0)
    for (const t of q) {
      const df = this.df.get(t)
      if (!df) continue
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5))
      for (let i = 0; i < this.n; i++) {
        const f = this.tf[i].get(t)
        if (!f) continue
        const denom = f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgLen)
        out[i] += idf * ((f * (this.k1 + 1)) / denom)
      }
    }
    return out
  }

  /** 取分数最高的 k 块，按原文顺序返回（保持阅读顺序，模型更容易理解） */
  topK(query, k) {
    const scores = this.score(query)
    return scores
      .map((s, i) => ({ i, s }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .sort((a, b) => a.i - b.i)
      .map((x) => ({ index: x.i, score: x.s, text: this.chunks[x.i] }))
  }
}

/** 归一化用于"检索是否命中标准证据"的判断 */
const norm = (s) => String(s || '').replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, '').replace(/[，。、；：（）()\[\]「」【】《》"'`~!@#$%^&*_+=|\\/<>,.;:?\-—]/g, '').toLowerCase()

/**
 * 检索评估：标准证据段落是否被召回（按"证据片段中有多少 40 字窗口出现在检索结果里"衡量）
 * 返回 {hit, coverage}：hit=至少一个窗口命中；coverage=窗口命中比例
 */
function retrievalHit(retrievedText, evidenceText) {
  const ev = norm(evidenceText)
  if (!ev) return { hit: false, coverage: 0, windows: 0 }
  const W = 40
  const got = norm(retrievedText)
  let hit = 0
  let windows = 0
  for (let i = 0; i + W <= ev.length; i += W) {
    windows++
    if (got.includes(ev.slice(i, i + W))) hit++
  }
  if (windows === 0) { windows = 1; hit = got.includes(ev) ? 1 : 0 }
  return { hit: hit > 0, coverage: hit / windows, windows }
}

/** 金融同义词表：左=问题常用说法，右=年报里的说法（双向扩展） */
const SYNONYMS = [
  ['capex', 'capital expenditures', 'capital spending', 'purchases of property'],
  ['revenue', 'net sales', 'total revenues', 'net revenues', 'total net sales'],
  ['net income', 'net earnings', 'net income attributable'],
  ['cogs', 'cost of sales', 'cost of goods sold', 'cost of revenue'],
  ['operating income', 'operating profit', 'income from operations'],
  ['inventory', 'inventories'],
  ['receivables', 'accounts receivable'],
  ['payables', 'accounts payable'],
  ['dpo', 'days payable outstanding', 'payable days'],
  ['dso', 'days sales outstanding'],
  ['quick ratio', 'acid test'],
  ['current ratio', 'working capital'],
  ['roe', 'return on equity'],
  ['roa', 'return on assets'],
  ['fcf', 'free cash flow'],
  ['ebitda', 'earnings before interest'],
  ['ebit', 'operating earnings'],
  ['dividend', 'dividends paid', 'dividend payout'],
  ['buyback', 'repurchase', 'share repurchases'],
  ['inventory turnover', 'inventory turns', 'cost of sales divided by'],
  ['margin', 'operating margin', 'gross margin', 'net margin'],
  ['headcount', 'employees', 'number of employees'],
  ['segment', 'reportable segment', 'business segment'],
  ['litigation', 'legal proceedings', 'contingencies'],
  ['lease', 'operating lease', 'finance lease'],
]
const EXPAND = new Map()
for (const group of SYNONYMS) for (const term of group) {
  const set = EXPAND.get(term) || new Set()
  for (const other of group) if (other !== term) set.add(other)
  EXPAND.set(term, set)
}

/** 报表关键词：用于"报表路由"加权 */
const STATEMENTS = {
  cashflow: ['cash flow', 'cash flows', 'operating activities', 'investing activities', 'financing activities', 'free cash flow', 'capital expenditure', 'capex', 'depreciation', 'dividend paid', 'repurchase'],
  balance: ['balance sheet', 'total assets', 'total liabilities', 'accounts receivable', 'accounts payable', 'inventories', 'equity', 'current assets', 'current liabilities', 'goodwill', 'quick ratio', 'current ratio', 'working capital', 'shareholders'],
  income: ['income statement', 'net sales', 'net revenue', 'revenue', 'gross margin', 'operating income', 'operating margin', 'net income', 'net earnings', 'eps', 'cost of sales', 'sga', 'sg&a', 'income tax'],
  equity: ['stockholders equity', 'shareholders equity', 'retained earnings', 'comprehensive income'],
}

function expandQuery(q) {
  const lower = String(q).toLowerCase()
  const extra = []
  for (const [term, alts] of EXPAND) if (lower.includes(term)) extra.push(...alts)
  return extra.length ? `${q} ${extra.join(' ')}` : q
}
function statementsOf(q) {
  const lower = String(q).toLowerCase()
  return Object.entries(STATEMENTS).filter(([, kws]) => kws.some((k) => lower.includes(k))).map(([n]) => n)
}
function lineItemPhrases(q) {
  const lower = String(q).toLowerCase()
  const out = []
  for (const [term, alts] of EXPAND) if (lower.includes(term)) out.push(term, ...alts)
  for (const m of lower.matchAll(/([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{1,}){0,3})\s+(?:for|of|in)\b/g)) out.push(m[1])
  return [...new Set(out)]
}
const yearsOf = (q) => [...new Set(String(q).match(/\b(19|20)\d{2}\b/g) || [])]

/**
 * 检索器：切块 + BM25 + 可选加权（同义词/行项目/报表路由/年份）+ 可选重排。
 *
 * 重排的动机（由实测决定）：D1 v2 的联合分布是
 *   「检索命中却答错 12 题」>「检索未命中而答错 6 题」——瓶颈已从召回转到**精度**：
 * 上下文里明明有答案，但 23k 字的证据里噪声太多，模型取错了行项目。
 * 所以先按召回优先取 recallK 块，再用"行项目短语 + 年份 + 数字密度"这类**精确性信号**筛到 k 块。
 */
function buildRetriever(text, opts = {}) {
  const { size = 1400, overlap = 200, expand = true, phrase = true, route = true, year = true, rerank = false } = opts
  const chunks = chunk(text, { size, overlap })
  const bm = new BM25(chunks)
  const lower = chunks.map((c) => c.toLowerCase())
  const numCount = chunks.map((c) => (c.match(/\d[\d,]{2,}/g) || []).length)

  const baseScores = (query) => {
    const scores = bm.score(expand ? expandQuery(query) : query)
    const phrases = phrase ? lineItemPhrases(query) : []
    const targets = route ? statementsOf(query) : []
    const ys = year ? yearsOf(query) : []
    for (let i = 0; i < chunks.length; i++) {
      if (phrases.length) for (const p of phrases) if (lower[i].includes(p)) { scores[i] += 1.6; break }
      if (targets.length) for (const t of targets) if (STATEMENTS[t].some((kw) => lower[i].includes(kw))) { scores[i] += 1.2; break }
      if (ys.length && ys.some((y) => lower[i].includes(y))) scores[i] += 0.8
    }
    return scores
  }

  /** 精确性重排：只看"这一块是否同时具备行项目名、目标年份、足够数字" */
  const precisionScore = (i, query) => {
    const phrases = lineItemPhrases(query)
    const ys = yearsOf(query)
    let s = 0
    for (const p of phrases) if (lower[i].includes(p)) { s += 2.0; break }
    if (ys.length) for (const y of ys) if (lower[i].includes(y)) { s += 1.5; break }
    if (numCount[i] >= 6) s += 1.0
    else if (numCount[i] >= 3) s += 0.5
    // 过长的块往往是大段叙述，不是取数区
    if (chunks[i].length > size * 1.6) s -= 0.5
    return s
  }

  return {
    chunks,
    topK(query, k, { recallK = 0 } = {}) {
      const scores = baseScores(query)
      const ranked = scores.map((s, i) => ({ i, score: s })).sort((a, b) => b.score - a.score)
      let keep
      if (rerank && recallK > k) {
        const recalled = ranked.slice(0, recallK)
        const reranked = recalled
          .map((x) => ({ ...x, p: precisionScore(x.i, query) }))
          .sort((a, b) => b.p - a.p || b.score - a.score)
          .slice(0, k)
        keep = reranked
      } else {
        keep = ranked.slice(0, k)
      }
      return keep
        .sort((a, b) => a.i - b.i)
        .map((x) => ({ index: x.i, score: x.score, text: chunks[x.i] }))
    },
  }
}

module.exports = { chunk, BM25, tokenize, retrievalHit, norm, buildRetriever, expandQuery, statementsOf, lineItemPhrases, yearsOf, SYNONYMS, STATEMENTS }

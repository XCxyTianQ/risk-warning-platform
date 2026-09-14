/**
 * D1 检索调优（**零 API 成本**，纯离线）。
 *
 * 依据：D1 v1 的答题准确率 47.1% 几乎等于检索命中率 49.0%——瓶颈在检索。
 * 所以先把检索单独调到最好，再花模型调用去答题。
 *
 * 评价口径：以论文标注的支撑证据为真值，看 top-k 段落是否覆盖它（40 字窗口命中比例）。
 * 策略（逐项叠加，每项都要证明有增益才留下）：
 *   S0 基线：BM25 top-k（= D1 v1）
 *   S1 + 金融同义词扩展（问题用词与年报用词不一致是主要漏因）
 *   S2 + 行项目短语加权（问题里出现的行项目名，命中即加权）
 *   S3 + 报表路由（判断问的是三表里的哪一张，给该表所在块加权）
 *   S4 + 年份邻近加权（FY20xx 与数字同块）
 *   S5 + 自适应 k（长文档多取几块）
 *
 *   node bench/external/d1/tune-retrieval.js
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const { chunk, BM25, retrievalHit, tokenize } = require('./retrieval')

const EXT = path.join(__dirname, '..')
const TXT_DIR = path.join(EXT, 'cache', 'raw', 'financebench_text')
const OUT = path.join(EXT, 'out', 'd1-retrieval-tuning.json')

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

/** 报表关键词：用于"报表路由" */
const STATEMENTS = {
  cashflow: ['cash flow', 'cash flows', 'operating activities', 'investing activities', 'financing activities', 'free cash flow', 'capital expenditure', 'capex', 'depreciation', 'dividend paid', 'repurchase'],
  balance: ['balance sheet', 'total assets', 'total liabilities', 'accounts receivable', 'accounts payable', 'inventories', 'equity', 'current assets', 'current liabilities', 'goodwill', 'quick ratio', 'current ratio', 'working capital', 'shareholders'],
  income: ['income statement', 'net sales', 'net revenue', 'revenue', 'gross margin', 'operating income', 'operating margin', 'net income', 'net earnings', 'eps', 'cost of sales', 'sga', 'sg&a', 'income tax'],
  equity: ['stockholders equity', 'shareholders equity', 'retained earnings', 'comprehensive income'],
}

const expandQuery = (q) => {
  const lower = q.toLowerCase()
  const extra = []
  for (const [term, alts] of EXPAND) {
    if (lower.includes(term)) extra.push(...alts)
  }
  return extra.length ? `${q} ${extra.join(' ')}` : q
}

const statementsOf = (q) => {
  const lower = q.toLowerCase()
  const hits = []
  for (const [name, kws] of Object.entries(STATEMENTS)) {
    if (kws.some((k) => lower.includes(k))) hits.push(name)
  }
  return hits
}

const lineItemPhrases = (q) => {
  const phrases = []
  const lower = q.toLowerCase()
  for (const [term, alts] of EXPAND) if (lower.includes(term)) phrases.push(term, ...alts)
  // 也抓 "X of Y" 这类结构
  for (const m of lower.matchAll(/([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{1,}){0,3})\s+(?:for|of|in)\b/g)) phrases.push(m[1])
  return [...new Set(phrases)]
}

const yearsOf = (q) => [...new Set((q.match(/\b(19|20)\d{2}\b/g) || []))]

async function main() {
  const questions = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows.map((r) => ({
    id: r.financebench_id, doc: r.doc_name, type: r.question_type, question: r.question,
    gold: String(r.answer), evidence: (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n'),
  }))
  const byDoc = new Map()
  for (const q of questions) {
    if (!byDoc.has(q.doc)) byDoc.set(q.doc, [])
    byDoc.get(q.doc).push(q)
  }

  const strategies = [
    { id: 'S0', desc: 'BM25 top-k（D1 v1 基线）', k: 8, expand: false, phrase: false, route: false, year: false },
    { id: 'S1', desc: '+ 同义词扩展', k: 8, expand: true, phrase: false, route: false, year: false },
    { id: 'S2', desc: '+ 行项目短语加权', k: 8, expand: true, phrase: true, route: false, year: false },
    { id: 'S3', desc: '+ 报表路由加权', k: 8, expand: true, phrase: true, route: true, year: false },
    { id: 'S4', desc: '+ 年份邻近加权', k: 8, expand: true, phrase: true, route: true, year: true },
    { id: 'S5', desc: 'S4 + k=16', k: 16, expand: true, phrase: true, route: true, year: true },
    { id: 'S6', desc: 'S4 + k=24', k: 24, expand: true, phrase: true, route: true, year: true },
  ]
  const results = Object.fromEntries(strategies.map((s) => [s.id, { ...s, hit: 0, n: 0, coverage: 0, perType: {} }]))

  let docsDone = 0
  for (const [doc, qs] of byDoc) {
    const txtFile = path.join(TXT_DIR, `${doc}.txt`)
    if (!fs.existsSync(txtFile)) continue
    const text = fs.readFileSync(txtFile, 'utf8')
    const chunks = chunk(text, { size: 1400, overlap: 200 })
    const bm = new BM25(chunks)
    const chunkTokens = chunks.map((c) => new Set(tokenize(c)))
    const chunkLower = chunks.map((c) => c.toLowerCase())

    for (const q of qs) {
      for (const s of strategies) {
        const query = s.expand ? expandQuery(q.question) : q.question
        const scores = bm.score(query).slice()
        if (s.phrase) {
          const phrases = lineItemPhrases(q.question)
          for (let i = 0; i < chunks.length; i++) {
            const lc = chunkLower[i]
            for (const p of phrases) if (lc.includes(p)) scores[i] += 1.6
          }
        }
        if (s.route) {
          const targets = statementsOf(q.question)
          for (let i = 0; i < chunks.length; i++) {
            const lc = chunkLower[i]
            for (const t of targets) if (STATEMENTS[t].some((k) => lc.includes(k))) scores[i] += 1.2
          }
        }
        if (s.year) {
          const ys = yearsOf(q.question)
          for (let i = 0; i < chunks.length; i++) {
            if (ys.length && ys.some((y) => chunkLower[i].includes(y))) scores[i] += 0.8
          }
        }
        const picked = scores.map((sc, i) => ({ i, sc })).sort((a, b) => b.sc - a.sc).slice(0, s.k).sort((a, b) => a.i - b.i)
        const evidence = picked.map((p) => chunks[p.i]).join('\n\n')
        const ret = retrievalHit(evidence, q.evidence)
        const r = results[s.id]
        r.n++
        r.coverage += ret.coverage
        if (ret.hit) r.hit++
        r.perType[q.type] = r.perType[q.type] || { n: 0, hit: 0 }
        r.perType[q.type].n++
        if (ret.hit) r.perType[q.type].hit++
      }
    }
    docsDone++
    if (docsDone % 10 === 0) process.stdout.write(`\r  已处理 ${docsDone}/${byDoc.size} 份文档`)
  }
  process.stdout.write('\n\n')

  console.log('=== 检索策略对比（以论文标注证据为真值，n=150）===')
  console.log('策略  说明                       命中率    平均覆盖率   指标类     领域推理   新颖生成')
  const rows = []
  for (const s of strategies) {
    const r = results[s.id]
    const p = (t) => (r.perType[t] ? `${r.perType[t].hit}/${r.perType[t].n}` : '—')
    console.log(`${s.id}    ${s.desc.padEnd(24)} ${((r.hit / r.n) * 100).toFixed(1).padStart(5)}%   ${((r.coverage / r.n) * 100).toFixed(1).padStart(5)}%     ${p('metrics-generated').padEnd(10)} ${p('domain-relevant').padEnd(10)} ${p('novel-generated')}`)
    rows.push({ id: s.id, desc: s.desc, k: s.k, hitPct: Number(((r.hit / r.n) * 100).toFixed(2)), coveragePct: Number(((r.coverage / r.n) * 100).toFixed(2)), perType: r.perType })
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), n: questions.length, strategies: rows }, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(EXT, '..', '..'), OUT)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })

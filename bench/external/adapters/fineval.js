/**
 * E2 · FinEval（NAACL 2025）—— 我们真正在意的两个子集
 *
 *  1. 金融严谨性-数值计算（42 题）：题目里已经给了检索内容，要求算出一个准确数值。
 *     与我们平台的"从财报文本取数并计算"是同一类任务，且答案是确定性数值 → 可直接判对错。
 *  2. 金融严谨性-指标抽取（340 题）：从检索内容中抽取指标并成句，参考答案是语句数组。
 *     判分用"语句召回/数字召回"（自实现、确定性）。
 *  3. FinEval-MM 多模态题（15 个题型文件）：**财报图表截图 + 四选一**，
 *     正好对应平台的图片取数链路，是本轮最能说明"多模态到底行不行"的部分。
 *
 * 注意：FinEval 的经典学术/行业选择题不在公开仓库（data-v2 为 .rar 且测试集答案不公开），
 * 因此我们只跑上面三个子集，并且**不把它当作"FinEval 总分"**，报告中必须写明这一点。
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const S = require('../sources')
const { sample, sampleStratified, hashOf } = require('../lib/sample')
const { mapLimit } = require('../lib/model')

function loadNumerical() {
  const t = F.parseTable(F.rawText('fineval/rigor_numerical.csv'), ',')
  return t.rows.map((r, i) => ({
    id: `rigor_numerical_${r['序号'] || i}`,
    kind: 'numerical',
    group: `金融严谨性/${r['类型'] || '数值计算'}`,
    query: r['基座query'] || r['端到端query'] || '',
    question: r['端到端query'] || '',
    gold: String(r['标准答案'] || '').trim(),
    logic: r['题目答案计算逻辑'] || '',
  })).filter((x) => x.query && x.gold)
}

function loadIndex() {
  const rows = F.parseDelimited(F.rawText('fineval/rigor_index.csv'), ',')
  const h = rows[0]
  const iId = h.indexOf('序号'), iType = h.indexOf('类型'), iQ = h.indexOf('基座大模型query'), iQ2 = h.indexOf('端到端query'), iRef = h.indexOf('参考答案')
  return rows.slice(1).map((r, i) => ({
    id: `rigor_index_${r[iId] || i}`,
    kind: 'index',
    group: `金融严谨性/指标抽取-${r[iType] || '未知'}`,
    subject: r[iType] || '未知',
    query: r[iQ] || r[iQ2] || '',
    question: r[iQ2] || '',
    gold: r[iRef] || '',
  })).filter((x) => x.query && x.gold)
}

async function loadMultimodal(log = () => {}) {
  log('  抓取 FinEval-MM 题型文件…')
  await S.ensureFinevalMM({ log: (m) => log(m) })
  const items = []
  for (const tsv of S.FINEVAL_MM) {
    const key = `fineval/mm_${tsv.split('/').pop()}`
    const t = F.parseTable(F.rawText(key), '\t')
    t.rows.forEach((r, i) => {
      const img = String(r.image || '').trim()
      const answer = String(r.answer || '').trim().toUpperCase()
      if (!img || !answer) return
      const choices = ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: String(r[k] || '').trim() })).filter((c) => c.text)
      items.push({
        id: `mm_${path.basename(tsv, '.tsv')}_${i}`,
        kind: 'multimodal',
        group: `FinEval-MM/${r.fintype || '未知'}`,
        fintype: r.fintype || '未知',
        type: r.type || '',
        image: `multimodeldata/${img.replace(/^data\//, '')}`,
        question: String(r.question || '').trim(),
        choices,
        gold: answer,
        background: String(r.background_story || '').trim(),
        information: String(r.information || '').trim(),
        round: String(r.round || '').trim(),
      })
    })
  }
  return items
}

/** 数值计算判分：先按"标准答案字符串包含"，再按数值容差，两者都记 */
function gradeNumerical(item, pred) {
  const p = String(pred || '')
  const contains = G.normChars(p).includes(G.normChars(item.gold))
  const nm = G.numericMatch(p, item.gold, 0.01)
  const hit = contains || (nm && nm.hit)
  return { correct: hit, viaContains: contains, viaNumeric: !!(nm && nm.hit), gold: item.gold }
}

module.exports = {
  id: 'fineval',
  title: 'FinEval 金融严谨性（数值计算 + 指标抽取）',
  layer: '数值严谨性层：从给定检索内容做金融数值计算与指标抽取',
  requiresVision: false,
  source: { repo: 'SUFE-AIFLM-Lab/FinEval', ref: 'main', paper: 'https://aclanthology.org/2025.naacl-long.318.pdf' },

  async plan({ seed = 20260101, sizes = {} } = {}) {
    const numerical = loadNumerical()
    const index = loadIndex()
    const nSample = sample(numerical, sizes.numerical ?? 42, seed, (x) => x.id)
    const iSample = sample(index, sizes.index ?? 340, seed + 1, (x) => x.id)
    const notes = [
      `数值计算 ${numerical.length} → 抽 ${nSample.items.length}（全量 42）`,
      `指标抽取 ${index.length} → 抽 ${iSample.items.length}`,
      'FinEval 经典学术/行业选择题未随仓库公开（data-v2 为 .rar 且测试集答案不公开），因此这不是 FinEval 总分',
      '题目自带的检索内容（基座query）已包含在提示词里，属"给定证据"口径，不测检索能力',
    ]
    return {
      tasks: [...nSample.items, ...iSample.items],
      sample: {
        numerical: { available: numerical.length, picked: nSample.items.length, hash: nSample.hash, seed },
        index: { available: index.length, picked: iSample.items.length, hash: iSample.hash, seed: seed + 1 },
      },
      notes,
    }
  },

  async run({ tasks, client, concurrency = 4, log = () => {} }) {
    const num = tasks.filter((t) => t.kind === 'numerical')
    const idx = tasks.filter((t) => t.kind === 'index')
    const rows = []

    // 1) 数值计算：题目自带检索内容。**用户消息使用官方 query 原文**，不加任何我方加工，
    //    避免"成绩来自我们的提示词工程"这类说不清的质疑。
    const numRows = await mapLimit(num, concurrency, async (t) => {
      const t0 = Date.now()
      try {
        const r = await client.chat({
          system: '你是严谨的金融数据助手。',
          user: t.query,
          maxTokens: 2048,
          kind: 'fineval-numerical',
        })
        const g = gradeNumerical(t, r.text)
        return { ...t, prediction: r.text.trim(), grade: g, correct: r.truncated && !r.text ? null : g.correct, ms: Date.now() - t0, usage: r.usage, error: null }
      } catch (e) {
        return { ...t, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })

    // 2) 指标抽取：同样使用官方 query 原文。参考答案是"把检索内容里的指标全部列出"，
    //    因此主指标是召回（语句/数字），外加一个苛刻的"完整率"（全部语句都命中）。
    let done = 0
    const idxRows = await mapLimit(idx, concurrency, async (t) => {
      const t0 = Date.now()
      try {
        const r = await client.chat({
          system: '你是金融数据抽取助手。',
          user: t.query,
          maxTokens: 3072,
          kind: 'fineval-index',
        })
        const g = G.gradeStatementRecall(t.gold, r.text)
        done++
        if (done % 25 === 0) log(`  FinEval 指标抽取 ${done}/${idx.length}`)
        return { ...t, prediction: r.text.trim(), grade: g, correct: r.truncated && !r.text ? null : g.statementRecall === 1, ms: Date.now() - t0, usage: r.usage, error: null }
      } catch (e) {
        return { ...t, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })

    // 3) 多模态部分见 adapters/fineval-mm.js（图像类基准按模型能力单独跑）
    rows.push(...numRows, ...idxRows)
    const clean = (rs) => rs.filter((r) => !r.error)
    const idxClean = clean(idxRows)
    const mean = (arr, f) => (arr.length ? Number((arr.reduce((s, x) => s + (f(x) || 0), 0) / arr.length).toFixed(4)) : null)

    const metrics = {
      numerical: {
        metric: '判对率（标准答案字符串包含 或 数值相对误差 ≤1%，含量纲换算）',
        overall: K.aggregate(clean(numRows), { groupKey: 'group' }).__ALL__,
        byGroup: K.aggregate(clean(numRows), { groupKey: 'group' }),
        viaContains: clean(numRows).filter((r) => r.grade && r.grade.viaContains).length,
        viaNumeric: clean(numRows).filter((r) => r.grade && r.grade.viaNumeric).length,
        errors: numRows.filter((r) => r.error).length,
      },
      indexExtraction: {
        metric: '语句召回（一条语句的全部数字都出现才算召回）+ 数字召回；完整率=全部语句命中（苛刻口径）',
        overall: K.aggregate(clean(idxRows), { groupKey: 'group' }).__ALL__,
        bySubject: K.aggregate(clean(idxRows), { groupKey: 'subject' }),
        meanStatementRecall: mean(idxClean, (r) => r.grade && r.grade.statementRecall),
        meanNumberRecall: mean(idxClean, (r) => r.grade && r.grade.numberRecall),
        meanStatementsPerQuestion: mean(idxClean, (r) => r.grade && r.grade.statements),
        completeRatePct: idxClean.length ? K.pct(idxClean.filter((r) => r.grade.statementRecall === 1).length / idxClean.length) : null,
        errors: idxRows.filter((r) => r.error).length,
      },
    }
    return { rows, metrics, groups: metrics.indexExtraction.bySubject }
  },
}

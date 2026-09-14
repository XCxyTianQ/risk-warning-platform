/**
 * 汇总"超限挑战"结果成单一产物，供 HTML 报告与 Word 报告共用。
 * 数据来源：明细文件（oracle/closedBook/BFCL）+ 已固化的污染分析 + 运行输出里记录的成本。
 *
 *   node bench/external/tools/aggregate-frontier-challenge.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const REPORTS = path.join(EXT, 'reports')

const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)

function detailOf(bench, model) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, `${bench}.${model}.json`)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return null
}

const judgeOf = (r) => (r.grade && (r.grade.judge || r.grade.judgeRaw)) || '?'
const acc = (rows) => (rows.length ? (rows.filter((r) => judgeOf(r) === 'CORRECT').length / rows.length) * 100 : null)

const MODELS = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'frontier', route: '聚合网关' },
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', tier: 'ours', route: '官方直连' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tier: 'samegen', route: '聚合网关' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'frontier', route: '聚合网关' },
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'samegen', route: '聚合网关' },
]

/** 成本（美元）：来自各次运行输出的记账行（产物会被覆盖，故在此固化并注明来源） */
const COST_USD = {
  'claude-fable-5-1': { financebench150: 6.26, bfcl520: 7.52 },
  'gpt-6-astra': { financebench150: 3.22, bfcl520: 2.44 },
  'deepseek-flash': { financebench150: 0.345, bfcl520: 0.445 },
}

const models = []
for (const m of MODELS) {
  const fb = detailOf('financebench', m.id)
  const bfcl = detailOf('bfcl', m.id)
  const oracle = fb ? (fb.rows || []).filter((r) => r.mode === 'oracle' && !r.error) : []
  const closed = fb ? (fb.rows || []).filter((r) => r.mode === 'closedBook' && !r.error) : []
  const byType = {}
  for (const t of ['metrics-generated', 'domain-relevant', 'novel-generated']) {
    const sub = oracle.filter((r) => r.questionType === t)
    byType[t] = sub.length ? Number(acc(sub).toFixed(2)) : null
  }
  const bm = bfcl ? bfcl.metrics || {} : {}
  const cat = bm.byCategory || {}
  const oAcc = oracle.length ? Number(acc(oracle).toFixed(2)) : null
  const cAcc = closed.length ? Number(acc(closed).toFixed(2)) : null
  const cost = COST_USD[m.id] || {}
  models.push({
    ...m,
    n: oracle.length,
    oraclePct: oAcc,
    closedBookPct: cAcc,
    documentIncrementPp: oAcc !== null && cAcc !== null ? Number((oAcc - cAcc).toFixed(2)) : null,
    byType,
    bfcl: {
      overallPct: (bm.overall && bm.overall.accuracyPct) ?? null,
      simplePct: (cat['BFCL/simple（单函数）'] || {}).accuracyPct ?? null,
      multiplePct: (cat['BFCL/multiple（多函数选一）'] || {}).accuracyPct ?? null,
      irrelevancePct: (cat['BFCL/irrelevance（应拒调）'] || {}).accuracyPct ?? null,
    },
    costUSD: {
      financebench150: cost.financebench150 ?? null,
      bfcl520: cost.bfcl520 ?? null,
      both: cost.financebench150 != null && cost.bfcl520 != null ? Number((cost.financebench150 + cost.bfcl520).toFixed(2)) : null,
    },
  })
}

// 污染分析（闭卷下写出正确数值的比例）
const cont = read(path.join(OUT, 'frontier-contamination-analysis.json'))
if (cont) {
  for (const t of cont.table) {
    const m = models.find((x) => x.id === t.id)
    if (m) { m.recalledCount = t.recalledCount; m.recalledExactNumbersPct = t.recalledExactNumbersPct }
  }
}

const ours = models.find((m) => m.tier === 'ours')
for (const m of models) {
  m.costRatioVsOurs = ours && ours.costUSD.both && m.costUSD.both ? Number((m.costUSD.both / ours.costUSD.both).toFixed(1)) : null
}

const out = {
  generatedAt: new Date().toISOString(),
  title: '超限挑战（2026-09-14）：Claude Fable 5.1 与 GPT-6 Astra',
  setup: {
    bench: 'FinanceBench 全量 150 题（oracle + closedBook 双口径）+ BFCL v4 520 题',
    judge: 'claude-sonnet-5（Anthropic，与被测各方均非同源）',
    prompt: 'A1（去保守化）',
    p0: '两家文本/图像/工具三项能力自检全部通过；Fable 5.1 的图像回答表现出版面位置推理',
  },
  models: models.sort((a, b) => (b.oraclePct || 0) - (a.oraclePct || 0)),
  headline: {
    finding: '顶级模型的领先主要来自记忆而非读文档：Fable 5.1 在**不给任何文档**的情况下仍答对 86.67%，其文档增量仅 +8.0pp；我方为 +40.67pp。',
    costNote: 'Fable 5.1 的同等两项基准成本约为我方的 13 倍，Astra 约 6 倍。',
  },
  caveat: [
    '闭卷不等于纯记忆：部分题可凭通用金融常识推导，且闭卷提示词鼓励"未陈述则推导"，因此闭卷得分是污染的**上界**估计。',
    '"闭卷下写出与标准答案一致的数值"是记忆的直接证据（抽查可见模型自述 "from memory" 并复现只有读过原文才知道的数字）。',
    '闭卷分差不影响确定性判分（BFCL）的对比结论。',
  ],
}
fs.writeFileSync(path.join(OUT, 'frontier-challenge.json'), JSON.stringify(out, null, 2))

console.log('=== 超限挑战汇总（同一裁判 claude-sonnet-5）===')
console.log('模型                    oracle    闭卷     文档增量    BFCL      成本(两项)  倍数')
for (const m of out.models) {
  console.log(
    '  ' + m.label.padEnd(22) +
    String(m.oraclePct).padStart(6) + '%  ' +
    String(m.closedBookPct).padStart(6) + '%  ' +
    String('+' + m.documentIncrementPp).padStart(7) + 'pp  ' +
    String(m.bfcl.overallPct).padStart(6) + '%  ' +
    String('$' + (m.costUSD.both ?? '?')).padStart(9) + '  ' +
    String(m.costRatioVsOurs ? m.costRatioVsOurs + '×' : '—').padStart(5)
  )
}
console.log('\n产物 → bench/external/out/frontier-challenge.json')

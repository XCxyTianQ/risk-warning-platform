/**
 * 把"平台链路（口径 B）"加入模型对比。
 *
 * 为什么需要单独一张表：平台链路跑的是**平台自己的会话**（系统提示 + 预设 + 25 工具 + 编排），
 * 与"直连模型 + harness 提示词"的对比表不是同一个口径，硬塞进同一行会误导。
 * 因此这里做一张**同基准、分口径**的对照表，并标注哪些基准链路跑不了、原因是什么。
 *
 *   node bench/external/tools/aggregate-chain-comparison.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')

const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)

/** 最新一次平台链路运行 */
function latestChain() {
  const f = fs.readdirSync(OUT).filter((x) => /^platform-chain-.*\.json$/.test(x)).sort().pop()
  return f ? { file: f, data: JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) } : null
}

const chain = latestChain()
if (!chain) throw new Error('找不到平台链路产物')
const c = chain.data
const ext = read(path.join(EXT, 'reports', 'external-alignment-v1.json'))

/** 口径 A 的数字从**逐题明细**里取（官方产物的 headline 在某些版本里取不到，直接算更稳） */
function directStats(bench, model = 'deepseek-flash', filter = null) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, `${bench}.${model}.json`)
    if (!fs.existsSync(f)) continue
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    // CFLUE 的明细里混着知识题与应用题，必须按 kind/group 筛，否则会把 423 行当成一个数（踩过）
    const rows = (j.rows || []).filter((r) => !r.error && (!filter || filter(r)))
    if (!rows.length) continue
    const gradeOf = (r) => (r.grade && (r.grade.judge || r.grade.judgeRaw)) || null
    const correct = rows.filter((r) => (r.correct !== undefined && r.correct !== null ? r.correct : gradeOf(r) === 'CORRECT')).length
    return { n: rows.length, accuracyPct: Number(((correct / rows.length) * 100).toFixed(2)), file: path.relative(path.join(EXT, '..', '..'), f).replace(/\\/g, '/') }
  }
  return null
}
const isKnowledge = (r) => /knowledge/i.test(String(r.kind || r.group || ''))

/** 外部模型的同基准成绩（来自此前的同代/超限挑战产物） */
const fc = read(path.join(OUT, 'frontier-challenge.json'))
const sg = read(path.join(OUT, 'samegen-results.json'))
const external = []
if (fc) for (const m of fc.models) {
  const v = (fc.vision && fc.vision.rows || []).find((x) => x.id === m.id)
  external.push({
    id: m.id, label: m.label, tier: m.tier,
    financebenchOraclePct: m.oraclePct,
    bfclPct: m.bfcl.overallPct,
    finevalMmPct: v && v.finevalMm ? v.finevalMm.accuracyPct : null,
    cfluePct: null, // 外部模型未跑 CFLUE
  })
}

const BENCHES = [
  { id: 'cflue', name: 'CFLUE 中文金融知识（300 题）', chainAvailable: true },
  { id: 'fineval-mm', name: 'FinEval-MM 图表题（150 题）', chainAvailable: true },
  { id: 'financebench', name: 'FinanceBench oracle（150 题）', chainAvailable: false, why: '链路未接入：需要把论文证据段落作为长文本投喂，脚本尚未支持（下一步）' },
  { id: 'bfcl', name: 'BFCL v4 工具调用（520 题）', chainAvailable: false, why: '**口径上不适用**：BFCL 考的是模型对"给定函数 schema"的调用，而平台链路用的是平台自己的 25 个工具，无法注入 BFCL 的合成函数' },
  { id: 'omnidocbench', name: 'OmniDocBench 整页转写（18 页）', chainAvailable: false, why: '链路可支持（图片上传已有），本轮未跑' },
]

const rows = []
// 平台链路（口径 B）
rows.push({
  id: 'platform-chain', label: '平台链路（口径 B，deepseek-flash）', kind: 'chain', presetArm: c.presetArm || null, presetId: c.presetId || null,
  cflue: c.cflue ? { n: c.cflue.n, accuracyPct: c.cflue.accuracyPct, meanMs: c.cflue.meanMs, usedTools: c.cflue.usedTools, empty: c.cflue.emptyAnswers } : null,
  finevalMm: c.finevalMm ? { n: c.finevalMm.n, accuracyPct: c.finevalMm.accuracyPct, meanMs: c.finevalMm.meanMs, usedTools: c.finevalMm.usedTools } : null,
})
// 直连模型（口径 A）——从逐题明细实算
const dKn = directStats('cflue', 'deepseek-flash', isKnowledge)
const dMm = directStats('fineval-mm')
rows.push({
  id: 'direct', label: '直连模型（口径 A，harness 提示词，无平台编排）', kind: 'direct',
  cflue: dKn ? { n: dKn.n, accuracyPct: dKn.accuracyPct } : null,
  finevalMm: dMm ? { n: dMm.n, accuracyPct: dMm.accuracyPct } : null,
})

const out = {
  generatedAt: new Date().toISOString(),
  question: '把平台链路（口径 B）加入模型对比',
  chainFile: chain.file,
  note: [
    '平台链路与直连模型不是同一口径：前者带平台系统提示 + 预设 + 25 工具 + 会话编排，后者只有 harness 提示词。',
    '因此本表按**同一基准、分口径**并列，不与"原生模型"数字混算。',
    'BFCL 对平台链路口径上不适用（平台无法注入 BFCL 的合成函数），已在表内注明原因而非留空。',
  ],
  benchmarks: BENCHES,
  rows,
  externalModels: external,
  samegen: sg ? sg.candidates.map((x) => ({ id: x.model, label: x.label, oraclePct: x.financebench.oraclePct, bfclPct: x.bfcl.overallPct })) : null,
}
fs.writeFileSync(path.join(OUT, 'chain-comparison.json'), JSON.stringify(out, null, 2))

console.log('=== 平台链路 vs 直连模型（同基准并列）===')
const fmt = (x) => (x && x.accuracyPct !== null && x.accuracyPct !== undefined ? `${x.accuracyPct}%（n=${x.n}）` : '—')
for (const r of rows) {
  console.log(`  ${r.label}`)
  console.log(`     CFLUE 知识题   ${fmt(r.cflue)}${r.cflue && r.cflue.meanMs ? `  ${r.cflue.meanMs}ms/题，用工具 ${r.cflue.usedTools}` : ''}`)
  console.log(`     FinEval-MM    ${fmt(r.finevalMm)}${r.finevalMm && r.finevalMm.meanMs ? `  ${r.finevalMm.meanMs}ms/题` : ''}`)
}
console.log('\n=== 哪些基准链路跑不了（及原因）===')
for (const b of BENCHES) if (!b.chainAvailable) console.log(`  ✗ ${b.name}\n      ${b.why}`)
console.log('\n产物 → bench/external/out/chain-comparison.json')

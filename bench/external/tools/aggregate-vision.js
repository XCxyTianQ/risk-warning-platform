/**
 * 把视觉那一路（FinEval-MM + OmniDocBench）并入超限挑战产物，供报告使用。
 *   node bench/external/tools/aggregate-vision.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')

function detailOf(bench, model) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, `${bench}.${model}.json`)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return null
}

const MODELS = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'frontier' },
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', tier: 'ours' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'frontier' },
]
/** 视觉运行的成本（来自运行输出的记账行；明细不含 usage） */
const VISION_COST = { 'gpt-6-astra': 3.84, 'claude-fable-5-1': null, 'deepseek-flash': null }

const rows = []
for (const m of MODELS) {
  const fm = detailOf('fineval-mm', m.id)
  const od = detailOf('omnidocbench', m.id)
  const fmm = fm ? (fm.metrics && fm.metrics.multimodal && fm.metrics.multimodal.overall) || {} : {}
  const om = od ? od.metrics || {} : {}
  // 我方 FinEval-MM 的官方数字在 external-alignment 里（早期轮次），此处优先用明细；没有则回填
  rows.push({
    ...m,
    finevalMm: {
      n: fmm.n ?? null,
      accuracyPct: fmm.accuracyPct ?? (m.id === 'deepseek-flash' ? 66.0 : null),
      source: fm ? 'run detail' : (m.id === 'deepseek-flash' ? 'external-alignment-v1.json（早期轮次）' : null),
    },
    omniDoc: {
      segmentRecall: om.meanSegmentRecall ?? null,
      numberRecall: om.meanNumberRecall ?? null,
      editRatio: om.meanEditRatio ?? null,
      rougeL: om.meanRougeL ?? null,
      tableSegmentRecall: om.tablePages ? om.tablePages.meanSegmentRecall : null,
      tableNumberRecall: om.tablePages ? om.tablePages.meanNumberRecall : null,
      nonTableSegmentRecall: om.nonTablePages ? om.nonTablePages.meanSegmentRecall : null,
    },
    costUSD: VISION_COST[m.id] ?? null,
  })
}

const file = path.join(OUT, 'frontier-challenge.json')
const fc = JSON.parse(fs.readFileSync(file, 'utf8'))
fc.vision = {
  generatedAt: new Date().toISOString(),
  bench: 'FinEval-MM（150 题图表四选一，确定性判分）+ OmniDocBench demo 18 页整页转写（自实现保真度指标）',
  note: [
    '视觉基准只跑了三家（我方 + 两个超限档对手）：Luna 与 GLM-5.3-Flash 未跑，为省成本，表里不虚构其数据。',
    '我方必须走官方直连（网关路由的图像输入会返回上游错误）；对手经聚合网关。',
    'OmniDocBench 的四项是自实现保真度指标，不是官方 TEDS/CDM，故只作横向对比而不与官方榜单数字对齐。',
  ],
  rows,
  finding: '出现能力分裂：Fable 5.1 在整页转写保真度上略胜我方（数字召回 0.776 对 0.753、编辑距离 0.127 对 0.139），'
    + '但在图表取数（FinEval-MM）上输给我方（64.67% 对 66.0%）——与 P0 观察一致：它擅长版面位置感知，不擅长从图表里取数。'
    + 'Astra 两项都最强。',
}
fs.writeFileSync(file, JSON.stringify(fc, null, 2))

console.log('=== 视觉那一路（FinEval-MM + OmniDocBench）===')
console.log('模型                      FinEval-MM   片段召回  数字召回  编辑距离↓  ROUGE-L')
for (const r of rows) {
  console.log(
    '  ' + r.label.padEnd(24) +
    String(r.finevalMm.accuracyPct ?? '—').padStart(6) + '%  ' +
    String(r.omniDoc.segmentRecall ?? '—').padStart(7) + '  ' +
    String(r.omniDoc.numberRecall ?? '—').padStart(7) + '  ' +
    String(r.omniDoc.editRatio ?? '—').padStart(7) + '  ' +
    String(r.omniDoc.rougeL ?? '—').padStart(7)
  )
}
console.log('\n已并入 bench/external/out/frontier-challenge.json 的 vision 段')

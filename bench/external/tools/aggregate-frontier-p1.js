/**
 * 汇总超限挑战 P0/P1 结果。
 *   node bench/external/tools/aggregate-frontier-p1.js
 */
const fs = require('node:fs')
const path = require('node:path')
const OUT = path.join(__dirname, '..', 'out')
const REPORTS = path.join(__dirname, '..', 'reports')

const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)

// 同裁判重判的 dev60
const rejudge = read(path.join(OUT, 'rejudge-exp-claude-sonnet-5.json'))
// BFCL：从**逐题明细**里取（reports 目录里的产物会被后续运行覆盖，明细不会）
// 注意：明细文件里 metrics.overall 是对象（含 accuracyPct），且不含 usage——成本另记。
const BFCL_COST_RECORDED = {
  // 来源：当次运行的输出（"记账"行）。reports 产物已被后续运行覆盖，明细不含 usage，故在此固化。
  'gpt-6-astra': { calls: 520, costUSD: 2.44, seconds: 445.2 },
  'claude-fable-5-1': { calls: 520, costUSD: 7.52, seconds: 708.5 },
}
const bfclOf = (model) => {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, `bfcl.${model}.json`)
    if (!fs.existsSync(f)) continue
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const m = j.metrics || {}
    const cat = m.byCategory || {}
    const rec = BFCL_COST_RECORDED[model] || {}
    return {
      model,
      overallPct: (m.overall && m.overall.accuracyPct) ?? null,
      simplePct: (cat['BFCL/simple（单函数）'] || {}).accuracyPct ?? null,
      multiplePct: (cat['BFCL/multiple（多函数选一）'] || {}).accuracyPct ?? null,
      irrelevancePct: (cat['BFCL/irrelevance（应拒调）'] || {}).accuracyPct ?? null,
      calls: rec.calls ?? null,
      costUSD: rec.costUSD ?? null,
      seconds: rec.seconds ?? null,
      source: path.relative(path.join(__dirname, '..', '..'), f).replace(/\\/g, '/'),
    }
  }
  return null
}

const bfcl = {
  'claude-fable-5-1': bfclOf('claude-fable-5-1'),
  'gpt-6-astra': bfclOf('gpt-6-astra'),
}
// 同代测试里的三家（同一次运行，确定性判分）
const samegen = read(path.join(OUT, 'samegen-results.json'))
const refBfcl = {}
if (samegen) for (const c of samegen.candidates) refBfcl[c.model] = { overallPct: c.bfcl.overallPct, simplePct: c.bfcl.simplePct, multiplePct: c.bfcl.multiplePct, irrelevancePct: c.bfcl.irrelevancePct, label: c.label }

const result = {
  generatedAt: new Date().toISOString(),
  stage: 'P0 + P1',
  p0: { models: ['claude-fable-5-1', 'gpt-6-astra'], text: 'ok', vision: 'ok（Fable 5.1 in=4788 / Astra in=6494 tokens，两家的图像确实进入上下文）', tools: 'ok' },
  p1a: {
    bench: 'FinanceBench oracle, dev 60, A1 提示词, 同一裁判 claude-sonnet-5',
    note: '注意：实验脚本内自带的 88.33% 是三家用各自裁判得到的（我方自判）——不同尺子的相同数字不可比，已用同一裁判重判',
    results: rejudge ? rejudge.results : null,
  },
  p1b: { bench: 'BFCL v4 520 题（确定性判分，无裁判）', frontier: bfcl, comparison: refBfcl },
}
fs.writeFileSync(path.join(OUT, 'frontier-p1-results.json'), JSON.stringify(result, null, 2))

console.log('=== P1a FinanceBench dev 60（同一裁判 Sonnet 5）===')
if (rejudge) for (const [m, r] of Object.entries(rejudge.results)) {
  console.log(`  ${m.padEnd(20)} ${String(r.accuracyPct).padStart(6)}%  (${r.correct}/${r.n})   原判 ${r.originalJudge} ${r.originalAccuracyPct}%`)
}
console.log('\n=== P1b BFCL v4 520（确定性判分）===')
const rows = [
  ['claude-fable-5-1', bfcl['claude-fable-5-1']],
  ['deepseek-flash', refBfcl['deepseek-flash']],
  ['glm-5.3-flash', refBfcl['glm-5.3-flash']],
  ['gpt-6-astra', bfcl['gpt-6-astra']],
  ['gpt-5.6-luna', refBfcl['gpt-5.6-luna']],
].filter(([, v]) => v && v.overallPct != null)
rows.sort((a, b) => b[1].overallPct - a[1].overallPct)
for (const [m, v] of rows) {
  console.log(`  ${m.padEnd(20)} ${String(v.overallPct).padStart(6)}%   单函数 ${String(v.simplePct).padStart(5)}%  多函数 ${String(v.multiplePct).padStart(5)}%  拒调 ${String(v.irrelevancePct).padStart(5)}%`)
}
const cost = Object.values(bfcl).reduce((s, v) => s + ((v && v.costUSD) || 0), 0)
console.log(`\n  P1b 两家合计成本 $${cost.toFixed(2)}（Astra $${bfcl['gpt-6-astra'] ? bfcl['gpt-6-astra'].costUSD.toFixed(2) : '?'} / Fable $${bfcl['claude-fable-5-1'] ? bfcl['claude-fable-5-1'].costUSD.toFixed(2) : '?'}）`)
console.log('产物 → bench/external/out/frontier-p1-results.json')

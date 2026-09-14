/**
 * 从**已存的逐题明细**重算指标，不重新调用模型。
 *
 * 为什么需要它：判分口径或统计口径被修正时（例如"失败类型分布"把成功占位值也算了进去），
 * 不应该为此再花一次模型调用的钱。明细里存了模型原始作答与判分依据，重算即可。
 *
 *   node bench/external/tools/regrade-from-detail.js --only bfcl
 */
const fs = require('node:fs')
const path = require('node:path')
const K = require('../lib/kit')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const REPORT = path.join(EXT, 'reports', 'external-alignment-v1.json')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
const only = (arg('--only', 'bfcl') || '').split(',').map((s) => s.trim()).filter(Boolean)

function latestDetail(bench, model) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.reverse()) {
    const f = path.join(OUT, d, `${bench}.${model}.json`)
    if (fs.existsSync(f)) return { file: f, dir: d }
  }
  return null
}

let changed = 0
for (const bench of only) {
  const b = report.benchmarks[bench]
  if (!b) { console.log(`跳过 ${bench}：报告里没有该基准`); continue }
  for (const [model, run] of Object.entries(b.runs || {})) {
    if (run.error) continue
    const hit = latestDetail(bench, model)
    if (!hit) { console.log(`跳过 ${bench}/${model}：找不到明细`); continue }
    const data = JSON.parse(fs.readFileSync(hit.file, 'utf8'))
    const rows = (data.rows || []).filter((r) => !r.error)
    if (bench === 'bfcl') {
      const errorTypes = {}
      for (const r of rows) {
        if (!r.grade || r.grade.correct !== false) continue
        const t = r.grade.error_type || 'unknown'
        errorTypes[t] = (errorTypes[t] || 0) + 1
      }
      const failed = rows.filter((r) => r.grade && r.grade.correct === false).length
      run.metrics.errorTypeDistribution = errorTypes
      run.metrics.failedTotal = failed
      run.metrics.scoring = (run.metrics.scoring || '') + '（失败类型分布已修正为只统计失败样本）'
      run.detail = path.relative(path.join(EXT, '..', '..'), hit.file).replace(/\\/g, '/')
      console.log(`✅ ${bench}/${model}: 失败 ${failed} 例，类型分布=${JSON.stringify(errorTypes)}（明细来自 ${hit.dir}）`)
      changed++
    }
  }
}

if (changed) {
  report.notes = report.notes || []
  report.notes.push(`本文件的部分指标由 tools/regrade-from-detail.js 从逐题明细重算（未重新调用模型）：${only.join(', ')}`)
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
  console.log(`\n已更新 ${path.relative(process.cwd(), REPORT)}`)
} else {
  console.log('没有需要更新的内容')
}

// 顺带把各基准的通过率与失败数打印出来，便于人工核对
for (const [bid, b] of Object.entries(report.benchmarks)) {
  for (const [model, run] of Object.entries(b.runs || {})) {
    if (run.error) continue
    const m = run.metrics || {}
    const acc = m.overall && m.overall.accuracyPct
    console.log(`${bid}/${model}: n=${run.rows}${acc !== undefined ? `，总体 ${acc}%` : ''}`)
  }
}
console.log(`\n提示：本次只重算指标，未产生任何模型调用。收尾请重跑 python bench/external/report/make-alignment-report.py`)
void K

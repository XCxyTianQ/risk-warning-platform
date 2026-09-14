/**
 * 分析 FinanceBench 开源子集的"可切分维度"——决定雷达图能画几个轴。
 *
 * 只有"同一批题、同一口径下多方都有数字"的维度才能进雷达图，
 * 否则就是把不同卷子的分数画在同一张蜘蛛网上，看着漂亮但站不住。
 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const RAW = path.join(REPO, 'bench', 'external', 'cache', 'raw')

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))

const qs = readJsonl(path.join(RAW, 'financebench_open_source.jsonl'))
const counter = (key) => {
  const m = new Map()
  for (const q of qs) {
    const v = String(q[key] ?? '(空)')
    m.set(v, (m.get(v) || 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
for (const key of Object.keys(qs[0])) {
  const vals = counter(key)
  if (vals.length <= 12) console.log(`${key}: ${vals.map(([k, v]) => `${k}(${v})`).join(', ')}`)
  else console.log(`${key}: ${vals.length} 个不同取值（略）`)
}

// 公开模型结果文件
const pubFiles = fs.readdirSync(path.join(RAW)).filter((f) => /^financebench_results_/.test(f))
console.log('\n可用的公开结果文件:', pubFiles.join(', '))
for (const f of pubFiles) {
  const rows = readJsonl(path.join(RAW, f))
  const labels = {}
  for (const r of rows) labels[r.label] = (labels[r.label] || 0) + 1
  console.log(`  ${f}: n=${rows.length} ${JSON.stringify(labels)}`)
}

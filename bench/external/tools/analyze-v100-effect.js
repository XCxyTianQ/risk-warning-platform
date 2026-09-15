/**
 * v1.0.0 效果的分层配对分析（零 API 成本，纯用已有产物）。
 *
 * 关键：**必须按产品版本分组**。arm 名 "B0" 同时出现在两个版本上——
 *   改动前基线（15-36-02）与 v1.0.0 默认（23-09-17、00-15-33）；
 * 直接按 arm 合并会把两个版本混在一起，得出错误结论。
 *
 *   node bench/external/tools/analyze-v100-effect.js
 */
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'out')

/** 显式登记每次运行的（产品版本 × 配置），不靠 arm 名猜 */
const RUNS = [
  { file: 'chain-fb-2026-09-14T15-36-02.json', version: 'pre', arm: 'B0', label: '改动前基线' },
  { file: 'chain-fb-2026-09-14T23-09-17.json', version: 'v1', arm: 'B0', label: 'v1.0.0 默认（无预设）' },
  { file: 'chain-fb-2026-09-15T00-15-33.json', version: 'v1', arm: 'B0', label: 'v1.0.0 默认（无预设）' },
  { file: 'chain-fb-2026-09-15T00-36-58.json', version: 'v1', arm: 'BP', label: 'v1.0.0 + 内置预设' },
  { file: 'chain-fb-2026-09-15T00-56-48.json', version: 'v1', arm: 'BP', label: 'v1.0.0 + 内置预设' },
]

const runs = RUNS.filter((r) => fs.existsSync(path.join(OUT, r.file))).map((r) => {
  const data = JSON.parse(fs.readFileSync(path.join(OUT, r.file), 'utf8'))
  const arm = data.arms[0]
  return { ...r, rows: arm.rows.filter((x) => !x.error), n: arm.n, acc: arm.accuracyPct, refusals: arm.rows.filter((x) => x.judge === 'REFUSAL').length, ms: arm.meanMs }
})

const groups = {
  pre_B0: runs.filter((r) => r.version === 'pre'),
  v1_B0: runs.filter((r) => r.version === 'v1' && r.arm === 'B0'),
  v1_BP: runs.filter((r) => r.version === 'v1' && r.arm === 'BP'),
}

console.log('=== 参与分析的有效运行 ===')
for (const r of runs) console.log(`  ${r.version.padEnd(4)} ${r.arm.padEnd(3)} ${String(r.acc).padStart(6)}%  拒答 ${String(r.refusals).padStart(2)}  ${String(r.ms).padStart(5)}ms  ${r.file}`)

console.log('\n=== 分组汇总（pooled）===')
const summary = {}
for (const [k, list] of Object.entries(groups)) {
  if (!list.length) continue
  const n = list.reduce((s, r) => s + r.n, 0)
  const correct = list.reduce((s, r) => s + r.rows.filter((x) => x.correct).length, 0)
  const ref = list.reduce((s, r) => s + r.refusals, 0)
  const ms = Math.round(list.reduce((s, r) => s + r.ms * r.n, 0) / Math.max(1, n))
  summary[k] = { runs: list.length, n, correct, accuracyPct: Number(((correct / n) * 100).toFixed(2)), refusals: ref, refusalPct: Number(((ref / n) * 100).toFixed(2)), meanMs: ms }
  console.log(`  ${k.padEnd(7)} 运行 ${summary[k].runs} 次  n=${String(n).padStart(4)}  ${String(summary[k].accuracyPct).padStart(6)}%  拒答 ${String(ref).padStart(2)}（${summary[k].refusalPct}%）  ${ms}ms`)
}

/** 配对 McNemar（逐运行、逐题对齐） */
function paired(aKey, bKey) {
  let aw = 0, bw = 0, both = 0, neither = 0, used = 0
  for (const ra of groups[aKey] || []) {
    for (const rb of groups[bKey] || []) {
      const bm = new Map(rb.rows.map((x) => [x.id, x.correct === true]))
      for (const row of ra.rows) {
        if (!bm.has(row.id)) continue
        used++
        const x = row.correct === true, y = bm.get(row.id)
        if (x && y) both++
        else if (!x && !y) neither++
        else if (x && !y) aw++
        else bw++
      }
    }
  }
  const net = bw - aw
  const se = Math.sqrt(aw + bw)
  const z = se > 0 ? net / se : 0
  return { aKey, bKey, used, aw, bw, both, neither, net, z: Number(z.toFixed(2)), significant: Math.abs(z) >= 1.96 }
}

console.log('\n=== 配对比较（McNemar 近似；跨全部运行组合，题号对齐）===')
const pairs = [
  ['v1_B0', 'v1_BP', '内置预设的增量价值'],
  ['pre_B0', 'v1_BP', 'v1.0.0 相对改动前的总效果'],
  ['pre_B0', 'v1_B0', '仅产品提示/技能库（无预设）的效果'],
].map(([a, b, desc]) => ({ desc, ...paired(a, b) }))

console.log('对比                        说明                          配对样本  A对B错 B对A错  净差    z值   显著')
for (const p of pairs) {
  console.log(`${(p.aKey + ' vs ' + p.bKey).padEnd(18)} ${p.desc.padEnd(28)} ${String(p.used).padStart(6)} ${String(p.aw).padStart(6)} ${String(p.bw).padStart(6)} ${String(p.net >= 0 ? '+' + p.net : p.net).padStart(5)} ${String(p.z).padStart(6)}   ${p.significant ? '✅ 是' : '否'}`)
}
console.log('\n注：配对样本是"两个分组的运行两两组合"后的题次总数（如 1×2 次运行 = 2 倍题次），用于提高功效；')
console.log('    跨运行组合会重复计入同一道题，故 z 值偏乐观，应主要看净差的量级与方向的稳定性。')

fs.writeFileSync(path.join(OUT, 'v100-effect-analysis.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runs: runs.map(({ rows, ...r }) => r), summary, pairs }, null, 2))
console.log('\n产物 → bench/external/out/v100-effect-analysis.json')

/**
 * 汇总多次重复的 chain-financebench 产物，给出**合并后的配对比较**。
 *
 * 为什么必须配对：同一批 150 题上，两组之间的差异用"独立比例相减"会被样本方差淹没；
 * 配对（McNemar）只看"这题 A 对 B 错 / B 对 A 错"的净翻转，功效高得多。
 * 多次重复则进一步把单次自判的 ±2~3 题噪声平均掉。
 *
 *   node bench/external/tools/pool-chain-fb.js
 */
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'out')
const files = fs.readdirSync(OUT).filter((f) => /^chain-fb-.*\.json$/.test(f)).sort()
if (!files.length) throw new Error('找不到 chain-fb 产物')

const runs = files
  .map((f) => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) }))
  // 排除冒烟运行（题量远小于正式运行）：它们用的是同一批题的前几道，
  // 保留会重复计入同样几道题、轻微加权；正式分析只用满量运行
  .filter((r) => (r.data.limit || 0) >= 100)
if (!runs.length) throw new Error('没有满量运行（limit ≥ 100）可合并')
console.log(`=== 参与合并的运行：${runs.length} 次（已排除冒烟运行）===`)
for (const r of runs) {
  const ids = r.data.arms.map((a) => a.id).join(',')
  console.log(`  ${r.file}  组=[${ids}]  题量=${r.data.limit}  判票=${r.data.judgeVotes}`)
}

/** 收集每个组在每次运行里的逐题结果 */
const byArm = {}
for (const r of runs) {
  for (const a of r.data.arms) {
    byArm[a.id] = byArm[a.id] || []
    byArm[a.id].push({ file: r.file, rows: a.rows.filter((x) => !x.error), accuracyPct: a.accuracyPct, n: a.n })
  }
}

const pooled = {}
for (const [id, list] of Object.entries(byArm)) {
  const total = list.reduce((s, x) => s + x.n, 0)
  const correct = list.reduce((s, x) => s + x.rows.filter((r) => r.correct).length, 0)
  const refusals = list.reduce((s, x) => s + x.rows.filter((r) => r.judge === 'REFUSAL').length, 0)
  pooled[id] = { runs: list.length, n: total, correct, accuracyPct: Number(((correct / total) * 100).toFixed(2)), refusalPct: Number(((refusals / total) * 100).toFixed(2)) }
}
console.log('\n=== 合并后的各组表现 ===')
console.log('组   运行次数   n     准确率     拒答率')
for (const [id, p] of Object.entries(pooled).sort()) {
  console.log(`${id}   ${String(p.runs).padStart(6)}   ${String(p.n).padStart(4)}   ${String(p.accuracyPct).padStart(6)}%   ${String(p.refusalPct).padStart(5)}%`)
}

/** 配对比较：逐运行、逐题对齐（题号相同） */
function pairedCompare(aId, bId) {
  let aWin = 0, bWin = 0, both = 0, neither = 0, used = 0
  for (const r of runs) {
    const A = r.data.arms.find((x) => x.id === aId)
    const B = r.data.arms.find((x) => x.id === bId)
    if (!A || !B) continue
    const bm = new Map(B.rows.filter((x) => !x.error).map((x) => [x.id, x.correct === true]))
    for (const row of A.rows.filter((x) => !x.error)) {
      if (!bm.has(row.id)) continue
      used++
      const x = row.correct === true, y = bm.get(row.id)
      if (x && y) both++
      else if (!x && !y) neither++
      else if (x && !y) aWin++
      else bWin++
    }
  }
  const net = bWin - aWin
  // McNemar 精确检验（双尾）近似：净翻转 ≥ 约 1.96*sqrt(aWin+bWin) 才显著
  const se = Math.sqrt(aWin + bWin)
  const z = se > 0 ? net / se : 0
  return { aId, bId, used, aWin, bWin, both, neither, net, z: Number(z.toFixed(2)), significant: Math.abs(z) >= 1.96 }
}

const pairs = []
const ids = Object.keys(pooled).sort()
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push(pairedCompare(ids[i], ids[j]))

console.log('\n=== 配对比较（合并所有重复；McNemar 近似检验）===')
console.log('对比        共同样本   A对B错  B对A错   净差    z值    显著')
for (const p of pairs) {
  console.log(`${p.aId} vs ${p.bId}   ${String(p.used).padStart(6)}   ${String(p.aWin).padStart(5)}   ${String(p.bWin).padStart(5)}   ${String(p.net >= 0 ? '+' + p.net : p.net).padStart(4)}   ${String(p.z).padStart(5)}   ${p.significant ? '✅ 是' : '否'}`)
}
console.log('\n判定标准：|z| ≥ 1.96（双尾 5%）。未达显著即"当前证据不足以区分"。')

const out = { generatedAt: new Date().toISOString(), runs: runs.map((r) => r.file), pooled, pairs }
fs.writeFileSync(path.join(OUT, 'chain-fb-pooled.json'), JSON.stringify(out, null, 2))
console.log('\n产物 → bench/external/out/chain-fb-pooled.json')

/**
 * FinanceBench 错题归因（零模型调用，全部基于已存明细）。
 *
 * 目的：在动手优化之前，先搞清楚"丢的这几十道题到底丢在哪一类"。
 * 分类口径（可复核）：
 *   - refusal        模型明确拒答
 *   - unit_or_scale  预测里出现了与标准答案同量级但差 10 的整数次幂的数（元/千元/百万、百分数/小数）
 *   - near_miss      预测里出现了与标准答案相对误差 ≤5% 的数（数值算对但表述/口径被判错）
 *   - wrong_number   预测里有数，但与标准答案无关（取错行项目或算错）
 *   - no_number      预测里没有可用数值（标准答案为数值的题）
 *   - text_wrong     标准答案为文本类，且裁判判错
 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')

function latest(bench) {
  const dir = path.join(REPO, 'bench', 'external', 'out')
  const dirs = fs.readdirSync(dir).filter((d) => d.startsWith('run-')).sort().reverse()
  for (const d of dirs) {
    const f = path.join(dir, d, `${bench}.deepseek-flash.json`)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  throw new Error('找不到明细')
}
const nums = (t) => (String(t).match(/-?\d+(?:,\d{3})*(?:\.\d+)?%?/g) || []).map((s) => Number(s.replace(/[,%]/g, ''))).filter(Number.isFinite)
const goldNum = (g) => {
  const s = String(g).replace(/[^\d.\-]/g, '')
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

const d = latest('financebench')
const rows = d.rows.filter((r) => r.mode === 'oracle' && !r.error && r.grade)
const verdicts = {}
for (const r of rows) verdicts[r.grade.judge] = (verdicts[r.grade.judge] || 0) + 1
console.log(`oracle 题数 ${rows.length}；裁判分布 ${JSON.stringify(verdicts)}`)
console.log(`其中确定性判对 ${rows.filter((r) => r.correctDeterministic).length}，判错 ${rows.filter((r) => !r.correctDeterministic).length}`)

const buckets = { refusal: [], unit_or_scale: [], near_miss: [], wrong_number: [], no_number: [], text_wrong: [], judge_lenient: [] }
for (const r of rows) {
  const bad = r.grade.judge !== 'CORRECT'
  if (!bad) { if (!r.correctDeterministic) buckets.judge_lenient.push(r); continue }
  const pred = String(r.prediction || '')
  if (r.grade.judge === 'REFUSAL') { buckets.refusal.push(r); continue }
  const g = goldNum(r.gold)
  if (g === null) { buckets.text_wrong.push(r); continue }
  const cands = nums(pred)
  if (!cands.length) { buckets.no_number.push(r); continue }
  // 同量级但差 10^k
  const unitHit = cands.some((c) => {
    if (c === 0 || g === 0) return false
    const k = Math.round(Math.log10(Math.abs(c / g)))
    if (Math.abs(k) < 1 || Math.abs(k) > 9) return false
    const scaled = g * Math.pow(10, k)
    return Math.abs(c - scaled) / Math.abs(scaled) <= 0.01
  })
  const nearHit = cands.some((c) => (g === 0 ? Math.abs(c) < 1e-9 : Math.abs(c - g) / Math.abs(g) <= 0.05))
  if (unitHit) buckets.unit_or_scale.push(r)
  else if (nearHit) buckets.near_miss.push(r)
  else buckets.wrong_number.push(r)
}

console.log('\n=== 错因分布（裁判判错的题）===')
const total = Object.values(buckets).reduce((s, v) => s + v.length, 0)
for (const [k, v] of Object.entries(buckets)) {
  const label = { refusal: '拒答', unit_or_scale: '单位/量纲错', near_miss: '数值接近但被判错（5% 内）', wrong_number: '取错行项目或算错', no_number: '答非数值', text_wrong: '文本题答错', judge_lenient: '裁判判对但确定性判错（我方判分器偏严）' }[k]
  console.log(`  ${String(v.length).padStart(3)}  ${label}`)
}
console.log(`\n错题合计 ${total}；若把「单位/量纲错 + 数值接近」全部修正，可得 ${(((rows.length - buckets.wrong_number.length - buckets.no_number.length - buckets.text_wrong.length - buckets.refusal.length) / rows.length) * 100).toFixed(1)}%`)

console.log('\n=== 例题：单位/量纲错 ===')
buckets.unit_or_scale.slice(0, 5).forEach((r) => console.log(`  gold=${JSON.stringify(r.gold)}  pred=${JSON.stringify(String(r.prediction).slice(0, 110))}`))
console.log('\n=== 例题：数值接近但被判错 ===')
buckets.near_miss.slice(0, 5).forEach((r) => console.log(`  gold=${JSON.stringify(r.gold)}  pred=${JSON.stringify(String(r.prediction).slice(0, 110))}`))
console.log('\n=== 例题：取错/算错 ===')
buckets.wrong_number.slice(0, 5).forEach((r) => console.log(`  gold=${JSON.stringify(r.gold)}  pred=${JSON.stringify(String(r.prediction).slice(0, 110))}`))
console.log('\n=== 例题：文本题答错 ===')
buckets.text_wrong.slice(0, 4).forEach((r) => console.log(`  gold=${JSON.stringify(String(r.gold).slice(0, 90))}  pred=${JSON.stringify(String(r.prediction).slice(0, 90))}`))

// 按题型 × 错因
console.log('\n=== 题型 × 错因 ===')
const byType = {}
for (const r of rows) {
  const t = String(r.group || '').replace('FinanceBench/', '')
  byType[t] = byType[t] || { n: 0, correct: 0 }
  byType[t].n++
  if (r.grade.judge === 'CORRECT') byType[t].correct++
}
for (const [t, v] of Object.entries(byType)) console.log(`  ${t}: ${v.correct}/${v.n} = ${((v.correct / v.n) * 100).toFixed(1)}%`)

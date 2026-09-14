/**
 * 诊断：Fable 5.1 的闭卷（不给证据）为什么能被裁判判对 86.67%？
 *
 * 两种可能，处理方式完全不同：
 *  ① 数据污染：它确实"记得" FinanceBench 的答案 → 是基准的问题，必须在报告里标注
 *  ② 裁判被骗：答案没有正确数字，但语气自信/论证充分，把裁判说服了 → 是我们判分口径的问题，
 *     而且会同时抬高它的 oracle 分数（即 94.67% 也含水分）
 *
 *   node bench/external/tools/diagnose-fable-closedbook.js [--limit 8]
 */
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const limit = Number(arg('--limit', '8'))

function detailOf(bench, model) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, `${bench}.${model}.json`)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return null
}

const nums = (t) => (String(t).match(/-?\d+(?:[.,]\d+)?%?/g) || []).map((x) => x.replace(/,/g, ''))
const goldNum = (g) => { const s = String(g).replace(/[^\d.\-]/g, ''); const v = Number(s); return Number.isFinite(v) ? v : null }

const j = detailOf('financebench', 'claude-fable-5-1')
if (!j) throw new Error('找不到 Fable 5.1 的明细')
const rows = j.rows || []
const closed = rows.filter((r) => r.mode === 'closedBook')
console.log(`=== Fable 5.1 闭卷明细（n=${closed.length}）===`)

// 交叉表：裁判判定 × 确定性判定（注意 grade 是对象：{deterministic, how, judge, judgeRaw}）
const judgeOf = (r) => (r.grade && (r.grade.judge || r.grade.judgeRaw)) || '?'
const cross = {}
for (const r of closed) {
  const k = `judge=${judgeOf(r)} × det=${r.correctDeterministic ? 'right' : 'wrong'}`
  cross[k] = (cross[k] || 0) + 1
}
for (const [k, v] of Object.entries(cross).sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(42) + v)

// 重点：裁判判对、但确定性判错 —— 这些是"可疑正确"
const suspicious = closed.filter((r) => judgeOf(r) === 'CORRECT' && !r.correctDeterministic)
console.log(`\n=== 可疑正确（裁判判对但确定性判错）：${suspicious.length} 条，抽 ${limit} 条 ===`)
for (const r of suspicious.slice(0, limit)) {
  const g = goldNum(r.gold)
  const cands = nums(r.prediction).map(Number).filter(Number.isFinite)
  const hasGold = g !== null && cands.some((c) => Math.abs(c - g) <= Math.abs(g) * 0.02 || (g === 0 && Math.abs(c) < 1e-9))
  console.log(`\n[${r.id}] 题型=${r.questionType}`)
  console.log(`  问：${String(r.question).slice(0, 120)}`)
  console.log(`  gold=${JSON.stringify(String(r.gold).slice(0, 80))}`)
  console.log(`  答案中是否含 gold 数字：${hasGold ? '是（判分器数字匹配太严？）' : '否（那就是裁判被说服了）'}`)
  console.log(`  pred=${JSON.stringify(String(r.prediction).slice(0, 300))}`)
}

// 对照：我方模型的同类比例
const mine = detailOf('financebench', 'deepseek-flash')
if (mine) {
  const mc = (mine.rows || []).filter((r) => r.mode === 'closedBook')
  const ms = mc.filter((r) => r.grade === 'CORRECT' && !r.correctDeterministic)
  console.log(`\n=== 对照：我方闭卷 n=${mc.length}，可疑正确 ${ms.length}（${((ms.length / Math.max(1, mc.length)) * 100).toFixed(0)}%）`)
  const fa = closed.filter((r) => r.grade === 'CORRECT' && !r.correctDeterministic)
  console.log(`     Fable 5.1 可疑正确 ${fa.length}（${((fa.length / Math.max(1, closed.length)) * 100).toFixed(0)}%）`)
}

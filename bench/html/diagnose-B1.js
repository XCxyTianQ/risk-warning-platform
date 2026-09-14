/**
 * B1 负结果归因：为什么"确定性重排证据"反而变差？
 * 对比同一批题号上 A1（官方复跑）与 B1 的逐题判定，并检查被重排后的证据是否发生了破坏性改动。
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../external/lib/fetch')
const R = require('../external/lib/restructure')

const REPO = path.resolve(__dirname, '..', '..')
const EXP = path.join(REPO, 'bench', 'external', 'out', 'experiments')

const load = (re) => {
  const f = fs.readdirSync(EXP).filter((x) => re.test(x)).sort().pop()
  return f ? JSON.parse(fs.readFileSync(path.join(EXP, f), 'utf8')) : null
}
const b1 = load(/^exp-B1-dev-.*\.json$/)
if (!b1) throw new Error('找不到 B1 的 dev 结果')
const rows = new Map(b1.rows.map((r) => [r.id, r]))

// A1 的 dev 结果（同一批题号）
const a1 = load(/^exp-A1-dev-.*\.json$/)
const a1Map = new Map((a1 ? a1.rows : []).map((r) => [r.id, r]))

const qs = new Map(F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows.map((r) => [r.financebench_id, r]))
const evid = (q) => (q.evidence || []).map((e) => e.evidence_text || '').join('\n\n')

const flipped = { a1ok_b1bad: [], a1bad_b1ok: [] }
for (const [id, r] of rows) {
  const a = a1Map.get(id)
  if (!a) continue
  const aOk = a.judge === 'CORRECT'
  const bOk = r.judge === 'CORRECT'
  if (aOk && !bOk) flipped.a1ok_b1bad.push({ id, gold: r.gold, a1: a.prediction, b1: r.prediction, stats: r.evidenceStats })
  if (!aOk && bOk) flipped.a1bad_b1ok.push({ id, gold: r.gold, a1: a.prediction, b1: r.prediction, stats: r.evidenceStats })
}
console.log(`A1 对/B1 错：${flipped.a1ok_b1bad.length} 题；A1 错/B1 对：${flipped.a1bad_b1ok.length} 题`)
console.log(`净变化：${flipped.a1bad_b1ok.length - flipped.a1ok_b1bad.length} 题`)

console.log('\n=== A1 对但 B1 错（重点看证据被改成什么样）===')
for (const f of flipped.a1ok_b1bad.slice(0, 4)) {
  const q = qs.get(f.id)
  const rest = R.restructure(evid(q))
  console.log(`\n[${f.id}] 题型=${q.question_type}`)
  console.log(`  问：${String(q.question).slice(0, 110)}`)
  console.log(`  gold=${JSON.stringify(String(f.gold).slice(0, 60))}`)
  console.log(`  A1 答：${JSON.stringify(String(f.a1).slice(0, 150))}`)
  console.log(`  B1 答：${JSON.stringify(String(f.b1).slice(0, 150))}`)
  console.log(`  重排统计：期间=${JSON.stringify(rest.stats.periods)}(${rest.stats.periodSource}) 表格=${rest.stats.tables} 行=${rest.stats.rows}`)
  console.log(`  原始证据开头：${JSON.stringify(evid(q).slice(0, 200))}`)
  console.log(`  重排后开头：${JSON.stringify(rest.markdown.slice(0, 200))}`)
}

console.log('\n=== 被重排的证据里"叙述性文字"是否被切碎（表格张数分布）===')
const tables = [...rows.values()].map((r) => (r.evidenceStats && r.evidenceStats.tables) || 0)
const noTable = tables.filter((t) => t === 0).length
console.log(`  0 张表：${noTable} 题；1~2 张：${tables.filter((t) => t >= 1 && t <= 2).length}；3 张以上：${tables.filter((t) => t >= 3).length}（最多 ${Math.max(...tables)} 张）`)

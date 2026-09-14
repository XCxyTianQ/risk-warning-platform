/**
 * D1 诊断：未作答的题去哪了 + 检索为什么漏（错在关键词还是切块）。
 */
const fs = require('node:fs')
const path = require('node:path')
const EXT = path.join(__dirname, '..', 'external')
const EXP = path.join(EXT, 'out', 'experiments')

const f = fs.readdirSync(EXP).filter((x) => /^d1-dev-.*\.json$/.test(x)).sort().pop()
const j = JSON.parse(fs.readFileSync(path.join(EXP, f), 'utf8'))
console.log(`文件：${f}  记录 ${j.rows.length} 条（题解 ${j.n}）`)
const bad = j.rows.filter((r) => r.error)
console.log(`\n未作答 ${bad.length} 条：`)
for (const r of bad) console.log(`  ${r.id} ${r.doc}: ${String(r.error).slice(0, 90)}`)

const ok = j.rows.filter((r) => !r.error)
const miss = ok.filter((r) => r.retrieval && !r.retrieval.hit)
const got = ok.filter((r) => r.retrieval && r.retrieval.hit)
console.log(`\n检索命中 ${got.length}，未命中 ${miss.length}`)
console.log(`命中时答题正确率：${got.filter((r) => r.judge === 'CORRECT').length}/${got.length}`)
console.log(`未命中时答题正确率：${miss.filter((r) => r.judge === 'CORRECT').length}/${miss.length}`)

console.log('\n=== 未命中的题：问题与标准答案（看检索该抓什么）===')
for (const r of miss.slice(0, 8)) {
  console.log(`\n[${r.type}] ${r.id} (${r.doc})`)
  console.log(`  gold=${JSON.stringify(String(r.gold).slice(0, 70))}`)
  console.log(`  检索到的块号=${JSON.stringify(r.retrieval.chunkIndexes)}（共 ${r.chunks} 块，最高分 ${r.retrieval.topScore}）`)
}

// 问题里出现的"行项目词"是否能直接命中答案段（判断是否值得做同义词扩展）
const qs = fs.readFileSync(path.join(EXT, 'cache', 'raw', 'financebench_open_source.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
const qmap = new Map(qs.map((q) => [q.financebench_id, q]))
console.log('\n=== 未命中题的证据里，问题关键词的覆盖情况 ===')
const STOP = new Set(['what', 'was', 'were', 'the', 'for', 'and', 'does', 'did', 'how', 'much', 'many', 'which', 'that', 'this', 'from', 'with', 'value', 'amount', 'total', 'using', 'based', 'according', 'company', 'fy', 'year'])
const words = (s) => [...new Set(String(s).toLowerCase().match(/[a-z][a-z-]{2,}/g) || [])].filter((w) => !STOP.has(w))
for (const r of miss.slice(0, 8)) {
  const q = qmap.get(r.id)
  const ev = (q.evidence || []).map((e) => e.evidence_text || '').join(' ').toLowerCase()
  const ws = words(q.question)
  const present = ws.filter((w) => ev.includes(w))
  console.log(`  ${r.id}: 问题关键词 ${ws.length} 个，其中出现在标准证据里的 ${present.length} 个 → 缺：${ws.filter((w) => !ev.includes(w)).slice(0, 6).join(', ')}`)
}

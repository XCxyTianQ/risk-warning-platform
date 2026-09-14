/**
 * 证据文本结构勘察：B1（证据结构化）的规则必须按真实文本写，不能凭想象。
 * 输出：断行形态统计 + 若干条完整样例（含数字行/表头行的分布）。
 */
const F = require('../external/lib/fetch')

const rows = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
const ev = (r) => (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n')

const lines = (t) => t.split(/\r?\n/)
const isNumLine = (l) => /^[\s$€£(（-]*[\d,]+(\.\d+)?[)\s%]*$/.test(l.trim()) && /\d/.test(l)
const stat = { total: 0, withToc: 0, withPageNoise: 0, bigNumRuns: 0, periodHeader: 0, avgLines: 0, numHeavy: 0, tableLike: 0 }
let sumLines = 0
for (const r of rows) {
  const t = ev(r)
  if (!t) continue
  stat.total++
  const ls = lines(t)
  sumLines += ls.length
  if (/Table of Contents/i.test(t)) stat.withToc++
  if (ls.some((l) => /^\s*\d{1,3}\s*$/.test(l))) stat.withPageNoise++
  // 连续数字行 >= 3
  let run = 0, maxRun = 0
  for (const l of ls) {
    if (isNumLine(l)) { run++; maxRun = Math.max(maxRun, run) } else run = 0
  }
  if (maxRun >= 3) stat.bigNumRuns++
  if (/\b(19|20)\d{2}\b/.test(t) && /Years? ended|December 31|FY\s?20\d\d/i.test(t)) stat.periodHeader++
  const numLines = ls.filter(isNumLine).length
  if (numLines / Math.max(1, ls.length) > 0.3) stat.numHeavy++
  // 疑似"标签 + 多个数字"的表行
  if (ls.filter((l) => /[A-Za-z]{3,}.*\d[\d,]{2,}/.test(l)).length >= 3) stat.tableLike++
}
stat.avgLines = Number((sumLines / Math.max(1, stat.total)).toFixed(1))
console.log('=== 证据文本形态统计（n=%d）===', stat.total)
for (const [k, v] of Object.entries(stat)) console.log(`  ${k}: ${v}`)

console.log('\n=== 样例 1：典型"数字被拆成独立行" ===')
const s1 = rows.find((r) => (ev(r).match(/\n\s*\d[\d,]*\s*\n/g) || []).length >= 6)
console.log(JSON.stringify(ev(s1).slice(0, 1200)))

console.log('\n=== 样例 2：含 Table of Contents 噪音 ===')
const s2 = rows.find((r) => /Table of Contents/i.test(ev(r)))
console.log(JSON.stringify(ev(s2).slice(0, 900)))

console.log('\n=== 样例 3：行内即"标签+数字"的表（最容易处理）===')
const s3 = rows.find((r) => {
  const ls = lines(ev(r))
  return ls.filter((l) => /[A-Za-z]{3,}.*\d[\d,]{2,}/.test(l)).length >= 6
})
console.log(JSON.stringify(ev(s3).slice(0, 1200)))

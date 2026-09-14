/**
 * B1 自检：对全部 150 条证据做结构化，报告覆盖率与**硬约束**（数字一个都不能丢）。
 * 这份输出直接进报告，用来证明"结构化没有偷偷删掉任何数值"。
 */
const F = require('../external/lib/fetch')
const R = require('../external/lib/restructure')

const rows = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
const ev = (r) => (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n')

const agg = { n: 0, restructured: 0, tables: 0, tableRows: 0, periodNone: 0, invariantFail: 0, chars0: 0, chars1: 0, numLost: 0 }
const fails = []
for (const r of rows) {
  const t = ev(r)
  if (!t) continue
  const { markdown, stats } = R.restructure(t)
  agg.n++
  agg.chars0 += t.length
  agg.chars1 += markdown.length
  if (stats.tables > 0) agg.restructured++
  agg.tables += stats.tables
  agg.tableRows += stats.rows
  if (stats.periodCount < 2) agg.periodNone++
  if (!stats.numbersPreserved) {
    agg.invariantFail++
    agg.numLost += Math.abs(stats.numbersBefore - stats.numbersAfter)
    fails.push({ id: r.financebench_id, before: stats.numbersBefore, after: stats.numbersAfter })
  }
}
const pctOf = (a, b) => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`
console.log('=== B1 证据结构化的覆盖与安全性（n=%d）===', agg.n)
console.log(`  产出至少 1 张表的证据：${agg.restructured}（${pctOf(agg.restructured, agg.n)}）`)
console.log(`  未能识别期间表头的证据：${agg.periodNone}（${pctOf(agg.periodNone, agg.n)}）`)
console.log(`  共生成表格 ${agg.tables} 张、表格行 ${agg.tableRows} 行`)
console.log(`  字符数：原始 ${agg.chars0} → 结构化后 ${agg.chars1}（${pctOf(agg.chars1, agg.chars0)}）`)
console.log(`  **硬约束（数字多重集一致）**：失败 ${agg.invariantFail} 条${agg.invariantFail ? '，共丢 ' + agg.numLost + ' 个数字' : ' ✅'}`)
if (fails.length) fails.slice(0, 5).forEach((f) => console.log(`    ${f.id}: ${f.before} → ${f.after}`))

// 样例对照
const sample = rows.find((r) => (ev(r).match(/\n\s*\d[\d,]*\s*\n/g) || []).length >= 6)
const s = R.restructure(ev(sample))
console.log('\n=== 结构化样例（截取前 22 行）===')
console.log(s.markdown.split('\n').slice(0, 22).join('\n'))
console.log(`\n（该条：期间 ${JSON.stringify(s.stats.periods)}，表格 ${s.stats.tables} 张，行 ${s.stats.rows} 行，数字保留 ${s.stats.numbersPreserved}）`)

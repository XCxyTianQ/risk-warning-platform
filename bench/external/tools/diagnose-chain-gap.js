/**
 * 口径 B（平台链路）失分诊断：把 −18.8pp 拆到具体失败模式上。
 *
 * 关键问题不是"掉了多少"，而是"掉在哪"：
 *  - 空回答 / 截断（模型没输出）
 *  - 格式漂移（输出了分析过程而不是选项）
 *  - 工具误用（该用没用 / 不该用却用了）
 *  - 编排开销（多轮工具调用把上下文塞满）
 * 这四类的修法完全不同，可行性判断必须建立在这个拆解上。
 *
 *   node bench/external/tools/diagnose-chain-gap.js
 */
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'out')
const files = fs.readdirSync(OUT).filter((f) => /^platform-chain-.*\.json$/.test(f)).sort()
const latest = files[files.length - 1]
const j = JSON.parse(fs.readFileSync(path.join(OUT, latest), 'utf8'))
console.log(`=== 口径 B 产物：${latest} ===`)
console.log(`  模型 ${j.model} | 模式 ${j.mode} | 端口 ${j.port}`)
const c = j.cflue || {}
console.log(`  CFLUE：n=${c.n} 正确=${c.correct} 准确率=${c.accuracyPct}% | 用过工具的行=${c.usedTools} | 平均 ${Math.round((c.meanMs || 0))}ms | errors=${c.errors}`)

const rows = c.rows || []
const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const buckets = { empty: [], noLetter: [], toolUsed: [], toolUsedAndWrong: [], plainWrong: [], correct: [] }
for (const r of rows) {
  const p = strip(r.prediction)
  const hasLetter = /\b[A-D]\b/.test(p) || /^[A-D][.、)）]/.test(p)
  if (!p) buckets.empty.push(r)
  else if (!hasLetter) buckets.noLetter.push(r)
  else if (r.correct) buckets.correct.push(r)
  else buckets.plainWrong.push(r)
  if (r.toolCalls && r.toolCalls.length) { buckets.toolUsed.push(r); if (!r.correct) buckets.toolUsedAndWrong.push(r) }
}
console.log('\n=== 失败模式拆解 ===')
const pct = (x) => `${x}/${rows.length}（${((x / Math.max(1, rows.length)) * 100).toFixed(0)}%）`
console.log(`  空回答（模型没输出）      ${pct(buckets.empty.length)}`)
console.log(`  有内容但没有选项字母      ${pct(buckets.noLetter.length)}`)
console.log(`  给了字母但答错            ${pct(buckets.plainWrong.length)}`)
console.log(`  答对                      ${pct(buckets.correct.length)}`)
console.log(`  实际调用过工具的          ${pct(buckets.toolUsed.length)}（其中答错 ${buckets.toolUsedAndWrong.length}）`)

const show = (name, list, n = 4) => {
  if (!list.length) return
  console.log(`\n--- ${name} 样例 ---`)
  for (const r of list.slice(0, n)) {
    console.log(`  [${r.group || ''}] gold=${strip(r.gold).slice(0, 30)}`)
    console.log(`     pred=${JSON.stringify(strip(r.prediction).slice(0, 220))}`)
    if (r.toolCalls && r.toolCalls.length) console.log(`     工具：${r.toolCalls.map((t) => t.name || t).join(', ')}`)
    if (r.error) console.log(`     error=${String(r.error).slice(0, 120)}`)
  }
}
show('空回答', buckets.empty)
show('无选项字母', buckets.noLetter)
show('工具调用后仍答错', buckets.toolUsedAndWrong)

// 与口径 A（直连模型）的差距归因：把口径 A 的同题结果读出来做交集
const ext = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reports', 'external-alignment-v1.json'), 'utf8'))
const aRows = (((ext.benchmarks || {}).cflue || {}).runs || {})['deepseek-flash']
console.log('\n=== 口径 A 对照 ===')
console.log(`  CFLUE 口径 A：${aRows ? aRows.headline.find((h) => h.path === 'knowledge.overall').value + '%' : '未找到'}（直连模型，无平台编排）`)
console.log(`  口径 B：${c.accuracyPct}%  → 差 ${aRows ? (aRows.headline.find((h) => h.path === 'knowledge.overall').value - c.accuracyPct).toFixed(1) : '?'}pp`)
console.log('\n结论要点：若"空回答 + 无选项字母"占比高，则差距主要来自**输出契约与编排**（可修，属工程问题）；')
console.log('若"给了字母但答错"占比高，则差距来自**工具/上下文干扰**（也属工程，但更难）；')
console.log('若两类都不高，则说明平台链路本身没有系统性损失，差距只是样本波动。')

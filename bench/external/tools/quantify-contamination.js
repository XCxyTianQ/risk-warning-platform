/**
 * 污染量化：把"闭卷也能答对"作为污染计，算出每个模型的**文档阅读增量**。
 *
 * 为什么重要：FinanceBench 的 oracle 分数常被当作"读财报能力"，但如果模型不给文档也能答对，
 * 那部分分数来自记忆而非阅读。闭卷（closedBook）正是这个的对照实验。
 *
 *   node bench/external/tools/quantify-contamination.js
 */
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'out')

function detailOf(bench, model) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, `${bench}.${model}.json`)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return null
}

const MODELS = [
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['deepseek-flash', 'DeepSeek-V4.1-Flash（我方）'],
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
]

const judgeOf = (r) => (r.grade && (r.grade.judge || r.grade.judgeRaw)) || '?'
/** 答案里是否出现与标准答案一致的数值（2% 容差）——闭卷下出现即"记得" */
function containsGold(r) {
  const g = Number(String(r.gold).replace(/[^\d.\-]/g, ''))
  if (!Number.isFinite(g)) return false
  const cands = (String(r.prediction).match(/-?\d+(?:[.,]\d+)?/g) || []).map((x) => Number(x.replace(/,/g, '')))
  return cands.some((c) => (g === 0 ? Math.abs(c) < 1e-9 : Math.abs(c - g) <= Math.abs(g) * 0.02))
}

const table = []
for (const [id, label] of MODELS) {
  const j = detailOf('financebench', id)
  if (!j) { console.log(`  ⚠️ 跳过 ${id}（无明细）`); continue }
  const rows = (j.rows || []).filter((r) => !r.error)
  const oracle = rows.filter((r) => r.mode === 'oracle')
  const closed = rows.filter((r) => r.mode === 'closedBook')
  const acc = (arr) => (arr.length ? (arr.filter((r) => judgeOf(r) === 'CORRECT').length / arr.length) * 100 : null)
  const oAcc = acc(oracle)
  const cAcc = acc(closed)
  // 闭卷下的"记得数字"比例（更强证据：不给文档却写出了正确数值）
  const recalled = closed.filter((r) => judgeOf(r) === 'CORRECT' && containsGold(r)).length
  table.push({
    id, label, n: oracle.length,
    oraclePct: Number(oAcc.toFixed(2)),
    closedBookPct: Number(cAcc.toFixed(2)),
    documentIncrementPp: Number((oAcc - cAcc).toFixed(2)),
    recalledExactNumbersPct: Number(((recalled / Math.max(1, closed.length)) * 100).toFixed(2)),
    recalledCount: recalled,
  })
}

table.sort((a, b) => b.oraclePct - a.oraclePct)
console.log('=== FinanceBench 全量 150 · 同一裁判（claude-sonnet-5）===')
console.log('模型                         oracle    闭卷     文档增量   闭卷答对且写出正确数值')
for (const t of table) {
  console.log(
    '  ' + t.label.padEnd(26) +
    String(t.oraclePct).padStart(6) + '%  ' +
    String(t.closedBookPct).padStart(6) + '%  ' +
    String('+' + t.documentIncrementPp).padStart(7) + 'pp  ' +
    String(t.recalledCount + '/' + t.n).padStart(8) + `（${t.recalledExactNumbersPct}%）`
  )
}
fs.writeFileSync(path.join(OUT, 'frontier-contamination-analysis.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  judge: 'claude-sonnet-5', bench: 'FinanceBench oracle + closedBook, n=150',
  note: '文档增量 = oracle − 闭卷；增量越低说明分数越依赖记忆而非阅读。闭卷下写出正确数值是记忆的直接证据。',
  table,
}, null, 2))
console.log('\n产物 → bench/external/out/frontier-contamination-analysis.json')

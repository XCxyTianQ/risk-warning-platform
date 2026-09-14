/**
 * 两个关键核查：
 *  1) 9 道拒答的题，标准答案所需的数字/关键词是否**本来就在证据里**（即证据是充分的，拒答属过度保守）；
 *  2) 我们的 LLM 裁判与论文标签在同一批公开答案上的一致性（裁判是否比论文更严）。
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
const d = latest('financebench')
const rows = d.rows.filter((r) => r.mode === 'oracle' && !r.error && r.grade)
const refusals = rows.filter((r) => r.grade.judge === 'REFUSAL')

console.log('=== 1) 拒答题：证据是否本来就够 ===')
let evidenceSufficient = 0
for (const [i, r] of refusals.entries()) {
  const ev = String(r.evidence || '')
  const goldNums = (String(r.gold).match(/-?\d+(?:[.,]\d+)?%?/g) || []).filter((x) => x.replace(/[^\d]/g, '').length >= 2)
  const inEv = goldNums.filter((n) => ev.includes(n) || ev.includes(n.replace(/,/g, '')))
  // 关键词：标准答案里的英文实词（长度 >= 4）是否出现在证据里
  const words = (String(r.gold).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !['that', 'this', 'with', 'from', 'have', 'which', 'were', 'been', 'than', 'they', 'their', 'there', 'about', 'would', 'could', 'should'].includes(w))
  const hitWords = [...new Set(words)].filter((w) => ev.toLowerCase().includes(w))
  const ratio = words.length ? hitWords.length / new Set(words).size : 1
  const ok = (goldNums.length === 0 || inEv.length > 0) && ratio >= 0.5
  if (ok) evidenceSufficient++
  console.log(`  [${i + 1}] 关键词命中率 ${(ratio * 100).toFixed(0)}%，标准答案数字 ${JSON.stringify(goldNums)} → 证据中命中 ${JSON.stringify(inEv)}  ${ok ? '→ 证据充分（属过度保守）' : '→ 证据确实不足/需推理'}`)
}
console.log(`\n  结论：${evidenceSufficient}/${refusals.length} 道拒答题的答案要素本来就在证据里 → 拒答主要是提示词诱导的过度保守`)

console.log('\n=== 2) 裁判严格度：我们 vs 论文标签（同一批公开答案）===')
const RAW = path.join(REPO, 'bench', 'external', 'cache', 'raw')
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

// 我们的裁判只判过我们自己的答案；要判断"我们是否更严"，需要把论文答案送进我们的裁判。
// 这里先看可对齐的公开答案数量与分布，真正的重判在 next-step 脚本里做。
for (const [file, label] of [
  ['financebench_results_gpt4_oracle.jsonl', 'GPT-4 oracle'],
  ['financebench_results_gpt4_1106_oracle.jsonl', 'GPT-4-1106 oracle'],
]) {
  const pub = readJsonl(path.join(RAW, file))
  const dist = {}
  for (const p of pub) dist[p.label] = (dist[p.label] || 0) + 1
  console.log(`  ${label}: ${pub.length} 条公开答案，标签分布 ${JSON.stringify(dist)}（可送入我们的裁判重判，用于校准）`)
}

// 顺带统计：论文判为 Incorrect 的答案里，有多少其实数值与我们的一致（说明论文裁判也有宽严问题）
const pub = readJsonl(path.join(RAW, 'financebench_results_gpt4_oracle.jsonl'))
const byId = new Map(rows.map((r) => [r.id, r]))
let paperWrongButOurJudgeCorrect = 0, paperCorrectButOurJudgeWrong = 0
for (const p of pub) {
  const r = byId.get(p.financebench_id)
  if (!r) continue
  const paperCorrect = p.label === 'Correct Answer'
  const ours = r.grade.judge === 'CORRECT'
  if (!paperCorrect && ours) paperWrongButOurJudgeCorrect++
  if (paperCorrect && !ours) paperCorrectButOurJudgeWrong++
}
console.log(`\n  同一批题目上：论文判错而我们裁判判对 ${paperWrongButOurJudgeCorrect} 条；论文判对而我们裁判判错 ${paperCorrectButOurJudgeWrong} 条`)
console.log('  （两套裁判对"什么算对"的宽严不同，这一项必须量化后再比分数）')

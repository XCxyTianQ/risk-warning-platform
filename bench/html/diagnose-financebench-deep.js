/**
 * 深挖两类主要失分：拒答 与 文本题判错。
 * 另外顺手检查"裁判是否比论文更严"——这是我们自己的测量口径问题，必须先排除。
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

console.log('=== 一、9 道拒答：是真没证据，还是提示词让它"不敢答"？ ===')
const refusals = rows.filter((r) => r.grade.judge === 'REFUSAL')
refusals.forEach((r, i) => {
  console.log(`\n[${i + 1}] ${String(r.question).slice(0, 96)}`)
  console.log(`    gold=${JSON.stringify(String(r.gold).slice(0, 70))}`)
  console.log(`    pred=${JSON.stringify(String(r.prediction).slice(0, 130))}`)
  console.log(`    证据长度=${String(r.evidence || '').length} 字`)
})

console.log('\n\n=== 二、10 道"文本题判错"：答案到底对不对？ ===')
const textWrong = rows.filter((r) => r.grade.judge === 'INCORRECT' && !/^-?\$?[\d,.]+%?$/.test(String(r.gold).trim()))
textWrong.forEach((r, i) => {
  const goldNums = (String(r.gold).match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
  const predText = String(r.prediction)
  const hit = goldNums.filter((n) => predText.includes(String(n)))
  console.log(`\n[${i + 1}] 题型=${String(r.group).replace('FinanceBench/', '')}`)
  console.log(`    gold=${JSON.stringify(String(r.gold).slice(0, 100))}`)
  console.log(`    pred=${JSON.stringify(predText.slice(0, 200))}`)
  console.log(`    标准答案里的数字 ${JSON.stringify(goldNums)}，其中出现在预测里的：${JSON.stringify(hit)}`)
})

console.log('\n\n=== 三、裁判严格度自检：把"论文判对"的答案拿来给我们裁判重判会怎样？ ===')
const RAW = path.join(REPO, 'bench', 'external', 'cache', 'raw')
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
try {
  const pub = readJsonl(path.join(RAW, 'financebench_results_gpt4_oracle.jsonl'))
  const byId = new Map(rows.map((r) => [r.id, r]))
  let same = 0, oursStricter = 0, oursLooser = 0
  const examples = []
  for (const p of pub) {
    const r = byId.get(p.financebench_id)
    if (!r) continue
    const paperCorrect = p.label === 'Correct Answer'
    const ourCorrect = r.grade.judge === 'CORRECT'
    if (paperCorrect === ourCorrect) same++
    else if (paperCorrect && !ourCorrect) { oursStricter++; if (examples.length < 5) examples.push({ q: String(p.question).slice(0, 70), gold: String(p.gold_answer).slice(0, 40), ans: String(p.model_answer).slice(0, 90) }) }
    else oursLooser++
  }
  console.log(`  可对齐 ${same + oursStricter + oursLooser} 题：一致 ${same}，我们更严 ${oursStricter}，我们更松 ${oursLooser}`)
  console.log('  （注意：这只能用"论文公开答案 + 论文标签"来比——我们没有把论文答案送进我们的裁判，')
  console.log('   所以这里比的是"我方判分器/裁判"与论文标签在**同一批公开答案**上的一致程度）')
  examples.forEach((e) => console.log(`   论文判对/我方判错：${e.q} | gold=${e.gold} | ans=${e.ans}`))
} catch (e) {
  console.log('  读取论文结果失败：' + e.message)
}

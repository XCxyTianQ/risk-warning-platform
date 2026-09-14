/**
 * 把同一切分上多个模型的存量答案，用**同一个裁判**重判，得到可比的同尺子表格。
 *
 * 为什么需要：P1a 跑出来三家都是 88.3%，但我们的数字是"自判"、两家的数字是 Sonnet 5 判——
 * 不同尺子的相同数字没有可比性。这一步只花裁判钱（很便宜），不重跑作答。
 *
 *   node bench/external/tools/rejudge-exp.js --judge claude-sonnet-5 --models deepseek-flash,gpt-6-astra,claude-fable-5-1
 */
const fs = require('node:fs')
const path = require('node:path')
const K = require('../lib/kit')
const { ModelClient, mapLimit } = require('../lib/model')

const EXT = path.join(__dirname, '..')
const EXP = path.join(EXT, 'out', 'experiments')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

/** 取某模型最新一份 A1/dev 实验产物（优先非重判版，因为它记录的是该模型的原始候选） */
function latestExp(model, variant = 'A1', split = 'dev') {
  const files = fs.readdirSync(EXP)
    .filter((f) => new RegExp(`^exp-${variant}-${split}-`).test(f) && !/-rejudge\d+\.json$/.test(f))
    .sort()
  for (const f of files.slice().reverse()) {
    const j = JSON.parse(fs.readFileSync(path.join(EXP, f), 'utf8'))
    const u = j.usage && j.usage.author
    if (u && u.model === model) return { file: f, data: j }
  }
  return null
}

async function judgeOnce(judge, r) {
  const res = await judge.chat({
    system: 'You are a strict grader. Output exactly one word.',
    user: K.judgePrompt({ question: r.question, gold: r.gold, pred: r.prediction || '' }),
    maxTokens: 2048, kind: 'rejudge-exp',
  })
  return K.parseJudgeVerdict(res.text)
}

;(async () => {
  const judgeId = arg('--judge', 'claude-sonnet-5')
  const models = arg('--models', 'deepseek-flash,gpt-6-astra,claude-fable-5-1').split(',')
  const judge = new ModelClient({ model: judgeId })
  const out = {}
  console.log(`=== 同一裁判（${judgeId}）下的 dev 60 对比 ===`)
  for (const m of models) {
    const found = latestExp(m)
    if (!found) { console.log(`  ⚠️ 找不到 ${m} 的实验产物`); continue }
    const rows = (found.data.rows || []).filter((r) => r.prediction && !r.error)
    let done = 0
    const verdicts = await mapLimit(rows, 6, async (r) => {
      const v = await judgeOnce(judge, r).catch(() => 'ERROR')
      done++
      if (done % 20 === 0) process.stdout.write(`\r    ${m}: ${done}/${rows.length}   `)
      return { id: r.id, type: r.type, v }
    })
    process.stdout.write('\r' + ' '.repeat(60) + '\r')
    const ok = verdicts.filter((x) => x.v !== 'ERROR')
    const correct = ok.filter((x) => x.v === 'CORRECT').length
    const byType = {}
    for (const x of ok) { byType[x.type] = byType[x.type] || { n: 0, c: 0 }; byType[x.type].n++; if (x.v === 'CORRECT') byType[x.type].c++ }
    out[m] = { file: found.file, n: ok.length, correct, accuracyPct: Number(((correct / ok.length) * 100).toFixed(2)), byType, originalJudge: (found.data.usage && found.data.usage.judge && found.data.usage.judge.model) || null, originalAccuracyPct: found.data.accuracyPct }
    console.log(`  ${m.padEnd(20)} ${out[m].accuracyPct}%（${correct}/${ok.length}）  原判(${out[m].originalJudge || '?'}) ${out[m].originalAccuracyPct}%  ${Object.entries(byType).map(([t, v]) => `${t.slice(0, 6)}=${v.c}/${v.n}`).join(' ')}`)
  }
  const file = path.join(EXT, 'out', `rejudge-exp-${judgeId}.json`)
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), judge: judgeId, split: 'dev(60)', results: out, usage: judge.describe() }, null, 2))
  const u = judge.describe()
  console.log(`\n产物 → ${path.relative(path.join(EXT, '..', '..'), file)}；裁判 ${u.calls} 次，约 $${u.estimatedCostUSD ?? u.estimatedCostCNY}`)
})().catch((e) => { console.error(e); process.exit(1) })

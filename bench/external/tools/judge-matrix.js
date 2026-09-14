/**
 * 裁判矩阵：把每个候选模型的答案，交给**每一个中立裁判**重判一遍。
 *
 * 为什么必须做：同代对比里，如果每个模型的分数都由它自己判（或由各自的裁判判），
 * 差异里就混进了"尺子不同"。裁判矩阵给出 N×J 的分数表，并显式暴露两件事：
 *   1) 不同裁判之间是否一致（口径稳健性）
 *   2) 同一裁判下各模型的排序是否稳定（结论是否依赖裁判选择）
 *
 *   node bench/external/tools/judge-matrix.js --bench financebench --judges claude-sonnet-5,kimi-k3
 *   node bench/external/tools/judge-matrix.js --bench financebench --judges claude-sonnet-5 --votes 3
 */
const fs = require('node:fs')
const path = require('node:path')
const K = require('../lib/kit')
const { ModelClient, mapLimit, costOf } = require('../lib/model')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

/** 找每个模型最新的一份明细文件（同一模型可能有多次运行，取最新） */
function latestDetails(bench) {
  const found = new Map()
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(OUT, d))) {
      const m = f.match(new RegExp(`^${bench}\\.(.+)\\.json$`))
      if (!m) continue
      found.set(m[1], path.join(OUT, d, f))
    }
  }
  return found
}

/** 只判需要语义判定的题型（数值题可用确定性判分，不必花裁判钱） */
const needsJudge = (r) => r.mode !== 'closedBook' || true

async function judgeOnce(judge, r) {
  const res = await judge.chat({
    system: 'You are a strict grader. Output exactly one word.',
    user: K.judgePrompt({ question: r.question, gold: r.gold, pred: r.prediction || '' }),
    maxTokens: 2048, kind: 'judge-matrix',
  })
  return K.parseJudgeVerdict(res.text)
}

async function judgeVotes(judge, r, votes) {
  if (votes <= 1) return judgeOnce(judge, r)
  const all = await Promise.all(Array.from({ length: votes }, () => judgeOnce(judge, r).catch(() => 'ERROR')))
  const tally = {}
  for (const v of all) tally[v] = (tally[v] || 0) + 1
  return Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] === 'INCORRECT' ? -1 : 1))[0][0]
}

;(async () => {
  const bench = arg('--bench', 'financebench')
  const judges = arg('--judges', 'claude-sonnet-5').split(',').map((s) => s.trim()).filter(Boolean)
  const votes = Number(arg('--votes', 1))
  const onlyModels = arg('--models', '') ? arg('--models').split(',').map((s) => s.trim()) : null
  const mode = arg('--mode', 'oracle') // oracle | closedBook | all

  const details = latestDetails(bench)
  if (!details.size) throw new Error(`找不到 ${bench} 的明细文件（先跑 run.js）`)
  console.log(`=== 裁判矩阵 · ${bench} · 裁判 ${judges.join(' + ')} · 每题 ${votes} 票 ===`)
  for (const [m, f] of details) console.log(`  候选 ${m.padEnd(22)} ← ${path.relative(path.join(EXT, '..', '..'), f)}`)

  const judgeClients = judges.map((j) => ({ id: j, client: new ModelClient({ model: j }) }))
  const matrix = {}
  for (const [model, file] of details) {
    if (onlyModels && !onlyModels.includes(model)) continue
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rows = (data.rows || []).filter((r) => r.prediction && !r.error && (mode === 'all' || r.mode === mode) && needsJudge(r))
    if (!rows.length) { console.log(`  ⚠️ ${model} 在口径 ${mode} 下没有可用答案`); continue }
    matrix[model] = { file: path.relative(path.join(EXT, '..', '..'), file).replace(/\\/g, '/'), mode, n: rows.length, judges: {} }
    for (const { id: jid, client } of judgeClients) {
      let done = 0
      const verdicts = await mapLimit(rows, Number(arg('--concurrency', 6)), async (r) => {
        const v = await judgeVotes(client, r, votes).catch(() => 'ERROR')
        done++
        if (done % 50 === 0) process.stdout.write(`\r    ${model} × ${jid}: ${done}/${rows.length}   `)
        return { id: r.id, verdict: v }
      })
      process.stdout.write('\r' + ' '.repeat(70) + '\r')
      const ok = verdicts.filter((v) => v.verdict !== 'ERROR')
      const correct = ok.filter((v) => v.verdict === 'CORRECT').length
      const refused = ok.filter((v) => v.verdict === 'REFUSAL').length
      matrix[model].judges[jid] = {
        n: ok.length, correct, accuracyPct: Number(((correct / Math.max(1, ok.length)) * 100).toFixed(2)),
        refusalPct: Number(((refused / Math.max(1, ok.length)) * 100).toFixed(2)),
        errors: verdicts.length - ok.length,
        verdicts,
      }
      console.log(`  ${model.padEnd(22)} 由 ${jid.padEnd(18)} 判：${matrix[model].judges[jid].accuracyPct}%（${correct}/${ok.length}），拒答 ${refused}`)
    }
  }

  console.log('\n=== 汇总表（行=候选模型，列=裁判）===')
  const header = ['候选模型'.padEnd(22), ...judges.map((j) => j.padEnd(18)), '极差']
  console.log('  ' + header.join(' '))
  for (const [model, m] of Object.entries(matrix)) {
    const vals = judges.map((j) => (m.judges[j] ? m.judges[j].accuracyPct : null))
    const valid = vals.filter((v) => v !== null)
    const spread = valid.length > 1 ? (Math.max(...valid) - Math.min(...valid)).toFixed(1) : '—'
    console.log('  ' + [model.padEnd(22), ...vals.map((v) => (v === null ? '—' : String(v) + '%').padEnd(18)), spread].join(' '))
  }

  const usage = Object.fromEntries(judgeClients.map(({ id, client }) => {
    const u = client.describe()
    return [id, { calls: u.calls, promptTokens: u.promptTokens, completionTokens: u.completionTokens, estimatedCostUSD: u.estimatedCostUSD, estimatedCostCNY: u.estimatedCostCNY }]
  }))
  const file = path.join(OUT, `judge-matrix-${bench}.json`)
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), bench, mode, votes, judges, matrix, usage }, null, 2))
  const total = Object.values(usage).reduce((s, u) => s + (u.estimatedCostUSD || 0), 0)
  console.log(`\n产物 → ${path.relative(path.join(EXT, '..', '..'), file)}；裁判成本约 $${total.toFixed(3)}`)
  void costOf
})().catch((e) => { console.error(e); process.exit(1) })

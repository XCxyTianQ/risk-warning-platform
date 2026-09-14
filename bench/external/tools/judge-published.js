/**
 * 用**我们的裁判**去判论文公开的模型答案，得到"同一裁判下的对照分数"。
 *
 * 为什么必须做：目前 82% vs 84% 是两个不同裁判打出来的分（我们用自己的裁判，论文用他们的）。
 * 二者对"什么算对"的宽严不同——在同一批 150 题上，我们裁判与论文标签净差 3 道，恰好等于总分差距。
 * 只有把双方答案交给同一个裁判，比较才成立。
 *
 *   node bench/external/tools/judge-published.js --file financebench_results_gpt4_oracle.jsonl
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const K = require('../lib/kit')
const { ModelClient, mapLimit } = require('../lib/model')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

const FILES = [
  ['financebench_results_gpt4_oracle.jsonl', 'GPT-4（oracle）'],
  ['financebench_results_gpt4_1106_oracle.jsonl', 'GPT-4-1106（oracle）'],
  ['financebench_results_claude2_incontext.jsonl', 'Claude-2（in-context）'],
]

;(async () => {
  const only = arg('--file', '')
  const list = only ? FILES.filter(([f]) => f === only) : FILES
  const judge = new ModelClient({ model: arg('--judge', 'deepseek-flash') })
  const results = []
  for (const [file, label] of list) {
    const rows = F.parseJsonl(F.rawText('financebench/' + file.replace('financebench_', '').replace('.jsonl', '') + '.jsonl')).rows
    let done = 0
    const judged = await mapLimit(rows, Number(arg('--concurrency', 5)), async (r) => {
      try {
        const jr = await judge.chat({
          system: 'You are a strict grader. Output exactly one word.',
          user: K.judgePrompt({ question: r.question, gold: r.gold_answer, pred: String(r.model_answer || '') }),
          maxTokens: 2048, kind: 'judge-published',
        })
        done++
        if (done % 25 === 0) process.stdout.write(`\r    ${label} ${done}/${rows.length}`)
        return { id: r.financebench_id, paperLabel: r.label, ourVerdict: K.parseJudgeVerdict(jr.text), answer: String(r.model_answer || '').slice(0, 300) }
      } catch (e) {
        return { id: r.financebench_id, paperLabel: r.label, ourVerdict: 'ERROR', error: String(e.message).slice(0, 150) }
      }
    })
    process.stdout.write('\n')
    const ok = judged.filter((x) => x.ourVerdict !== 'ERROR')
    const ourCorrect = ok.filter((x) => x.ourVerdict === 'CORRECT').length
    const paperCorrect = ok.filter((x) => x.paperLabel === 'Correct Answer').length
    const stats = {
      label, file, n: ok.length,
      paperAccuracyPct: Number(((paperCorrect / ok.length) * 100).toFixed(2)),
      ourJudgeAccuracyPct: Number(((ourCorrect / ok.length) * 100).toFixed(2)),
      deltaPp: Number((((ourCorrect - paperCorrect) / ok.length) * 100).toFixed(2)),
      refused: ok.filter((x) => x.ourVerdict === 'REFUSAL').length,
      changedToCorrect: ok.filter((x) => x.paperLabel !== 'Correct Answer' && x.ourVerdict === 'CORRECT').length,
      changedToWrong: ok.filter((x) => x.paperLabel === 'Correct Answer' && x.ourVerdict !== 'CORRECT').length,
      rows: judged,
    }
    results.push(stats)
    console.log(`${label}: 论文标签 ${stats.paperAccuracyPct}% → 我们的裁判 ${stats.ourJudgeAccuracyPct}%（相差 ${stats.deltaPp >= 0 ? '+' : ''}${stats.deltaPp}pp）`)
    console.log(`   论文判错/我们判对 ${stats.changedToCorrect} 条；论文判对/我们判错 ${stats.changedToWrong} 条；我们判为拒答 ${stats.refused} 条`)
  }
  const file = path.join(OUT, 'judge-published.json')
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), judgeModel: judge.describe(), results }, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(EXT, '..', '..'), file)}`)
  console.log(`记账：${judge.describe().calls} 次裁判调用，约 ¥${judge.describe().estimatedCostCNY}`)
})().catch((e) => { console.error(e); process.exit(1) })

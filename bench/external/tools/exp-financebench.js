/**
 * FinanceBench 优化实验台（含 dev/test 切分纪律）。
 *
 * 规矩（写死在脚本里，不靠自觉）：
 *  1. 150 题按题型分层切成 dev 60 / test 90，切分结果落在 out/financebench-split.json 并入库；
 *  2. **只在 dev 上调参**；test 只在最后验证一次，脚本里用 --split test 才允许跑；
 *  3. 每个变体都要报告"相对 baseline 的配对差值"（同一批题号，同一裁判）；
 *  4. 未生效/变差的变体同样记录，不许只报最好看的那一版。
 *
 *   node bench/external/tools/exp-financebench.js --variant A1 --split dev
 *   node bench/external/tools/exp-financebench.js --list
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const R = require('../lib/restructure')
const { ModelClient, mapLimit } = require('../lib/model')
const { mulberry32, hashOf } = require('../lib/sample')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const SPLIT_FILE = path.join(OUT, 'financebench-split.json')
const REPORTS = path.join(EXT, 'out', 'experiments')
fs.mkdirSync(REPORTS, { recursive: true })

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes(n)

/**
 * 裁判多数投票：同一份答案判 N 次取多数。
 * 为什么需要：诊断 B1 负结果时发现，有 2/6 的"退化"其实是**同一份数字答案被判成了不同结论**
 * （同源裁判不稳定）。单次裁判带来 ±2~3 题（n=60）的噪声，足以把真实差异淹没。
 * 平票时按 INCORRECT 计（保守）。
 */
async function judgeWithVotes(judge, { question, gold, pred }, votes) {
  if (votes <= 1) {
    const jr = await judge.chat({ system: 'You are a strict grader. Output exactly one word.', user: K.judgePrompt({ question, gold, pred }), maxTokens: 2048, kind: 'exp-judge' })
    return K.parseJudgeVerdict(jr.text)
  }
  const all = await Promise.all(
    Array.from({ length: votes }, () =>
      judge.chat({ system: 'You are a strict grader. Output exactly one word.', user: K.judgePrompt({ question, gold, pred }), maxTokens: 2048, kind: 'exp-judge' })
        .then((r) => K.parseJudgeVerdict(r.text)).catch(() => 'ERROR'))
  )
  const tally = {}
  for (const v of all) tally[v] = (tally[v] || 0) + 1
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] === 'INCORRECT' ? -1 : 1))[0]
  return best ? best[0] : 'ERROR'
}

// ---------------------------------------------------------------- 提示词变体
const BASE_SYS = 'You are a financial analyst answering questions about corporate filings. Be concise and factual.'
const baseUser = (q, ev) => `Answer the following question using ONLY the document evidence provided below. Give a concise answer that states the requested figure and its unit. If the evidence does not contain the answer, say "I cannot determine the answer from the evidence."

[Question]
${q}

[Document evidence]
${ev}`

const VARIANTS = {
  A0: {
    label: 'A0 基线（原提示词，含"无法确定就拒答"）',
    system: BASE_SYS,
    user: (q, ev) => baseUser(q, ev),
  },
  A1: {
    label: 'A1 去保守化（证据必含答案，未直接陈述则推导）',
    system: BASE_SYS,
    user: (q, ev) => `Answer the following question using ONLY the document evidence provided below. The evidence is an excerpt from the company's own filing and it always contains the information needed to answer. If the answer is not stated verbatim, derive it from the evidence rather than declining. Give a concise answer.

[Question]
${q}

[Document evidence]
${ev}`,
  },
  A2: {
    label: 'A2 去保守化 + 先写行项目与单位再给结论',
    system: BASE_SYS,
    user: (q, ev) => `Answer the following question using ONLY the document evidence provided below. The evidence is an excerpt from the company's own filing and it always contains the information needed to answer; if it is not stated verbatim, derive it.

Answer in exactly this shape:
Line items: <the exact line item names and their values you used, with units and period>
Computation: <one line, or "direct extraction">
Final answer: <the requested figure with its unit; keep the unit used in the filing>

[Question]
${q}

[Document evidence]
${ev}`,
  },
  B1: {
    label: 'B1 A1 + 证据结构化（把断行的数字重排成表格）',
    system: BASE_SYS,
    user: (q, ev) => `Answer the following question using ONLY the document evidence provided below. The evidence is raw text extracted from a filing; numbers may have been split across lines — treat adjacent number lines as a table and align them by period. The evidence always contains the information needed; derive the answer if it is not stated verbatim.

[Question]
${q}

[Document evidence]
${ev}`,
  },
  B1: {
    label: 'B1 证据结构化（确定性重排成 Markdown 表）+ A1',
    preprocess: (ev) => R.restructure(ev),
    system: BASE_SYS,
    user: (q, ev) => `Answer the following question using ONLY the document evidence provided below. The evidence may already be laid out as Markdown tables (line items in rows, periods in columns) — use them as-is. It always contains the information needed; derive the answer if it is not stated verbatim.

[Question]
${q}

[Document evidence]
${ev}`,
  },
  B1b: {
    label: 'B1b 仅 LLM 结构化（让模型先把证据转成表格）再作答',
    structureStage: true,
    system: BASE_SYS,
    user: (q, ev) => `Answer the following question using ONLY the document evidence provided below. It always contains the information needed; derive the answer if it is not stated verbatim.

[Question]
${q}

[Document evidence]
${ev}`,
  },
  B1c: {
    label: 'B1c 确定性重排 + LLM 结构化 + 作答（三阶段，最贵）',
    preprocess: (ev) => R.restructure(ev),
    structureStage: true,
    system: BASE_SYS,
    user: (q, ev) => `Answer the following question using ONLY the document evidence provided below. It always contains the information needed; derive the answer if it is not stated verbatim.

[Question]
${q}

[Document evidence]
${ev}`,
  },
  B2: {
    label: 'B2 两阶段：先抽取候选行项目，再据此作答',
    twoStage: true,
    system: BASE_SYS,
  },
}

/** "只结构化、不作答"的提示词：把断行文本重排成 Markdown 表，不允许摘要或省略 */
const STRUCTURE_SYS = 'You reformat raw document text into Markdown tables. You never summarize, never omit a number, and never answer questions.'
const structureUser = (ev) => `Reformat the following document text into Markdown tables. Rules:
- Keep every number and every label; do not summarize, drop, or add anything.
- Put line items in rows and periods in columns when the layout allows.
- Keep narrative paragraphs as plain text between tables.

[Document text]
${ev}`

// ---------------------------------------------------------------- 切分（固定种子，分层）
function loadQuestions() {
  const rows = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
  return rows.map((r) => ({
    id: r.financebench_id,
    type: r.question_type,
    question: r.question,
    gold: String(r.answer),
    evidence: (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n').slice(0, 12000),
  }))
}

function ensureSplit(questions) {
  if (fs.existsSync(SPLIT_FILE)) return JSON.parse(fs.readFileSync(SPLIT_FILE, 'utf8'))
  const byType = {}
  for (const q of questions) (byType[q.type] = byType[q.type] || []).push(q)
  const dev = [], test = []
  let s = 20260914
  for (const t of Object.keys(byType).sort()) {
    const arr = byType[t].slice()
    const rnd = mulberry32((s = (s * 1664525 + 1013904223) >>> 0))
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]] }
    const nDev = Math.round(arr.length * 0.4) // 每类 50 → 20 dev / 30 test
    dev.push(...arr.slice(0, nDev))
    test.push(...arr.slice(nDev))
  }
  const split = {
    createdAt: new Date().toISOString(),
    rule: '按 question_type 分层，每类 40% 进 dev、60% 进 test；固定种子 20260914；切分冻结，后续调参只准用 dev',
    dev: dev.map((q) => q.id).sort(),
    test: test.map((q) => q.id).sort(),
    hash: { dev: hashOf(dev.map((q) => q.id).sort().join('\n')), test: hashOf(test.map((q) => q.id).sort().join('\n')) },
  }
  fs.writeFileSync(SPLIT_FILE, JSON.stringify(split, null, 2))
  return split
}

// ---------------------------------------------------------------- baseline（同一批题号，取历史明细）
function baselineRows() {
  const dir = path.join(EXT, 'out')
  const dirs = fs.readdirSync(dir).filter((d) => d.startsWith('run-')).sort().reverse()
  for (const d of dirs) {
    const f = path.join(dir, d, 'financebench.deepseek-flash.json')
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      return j.rows.filter((r) => r.mode === 'oracle' && !r.error && r.grade)
    }
  }
  return []
}

;(async () => {
  if (has('--list')) {
    for (const [k, v] of Object.entries(VARIANTS)) console.log(`${k}: ${v.label}`)
    return
  }

  // --rejudge：把某个变体的**存量答案**用多数投票裁判重判，不重新调用作答模型
  const rejudge = arg('--rejudge', '')
  if (rejudge) {
    const src = JSON.parse(fs.readFileSync(path.resolve(EXT, 'out', 'experiments', rejudge), 'utf8'))
    const questions = loadQuestions()
    const qmap = new Map(questions.map((q) => [q.id, q]))
    const votes = Number(arg('--judge-votes', 3))
    const judge = new ModelClient({ model: arg('--judge', 'deepseek-flash') })
    console.log(`=== 重判 ${rejudge}（裁判投票 ${votes} 次/题，n=${src.rows.length}）===`)
    let done = 0
    const rows = await mapLimit(src.rows, Number(arg('--concurrency', 6)), async (r) => {
      const q = qmap.get(r.id)
      if (!q || r.error) return r
      const v = await judgeWithVotes(judge, { question: q.question, gold: q.gold, pred: r.prediction || '' }, votes)
      done++
      if (done % 15 === 0) process.stdout.write(`\r    重判 ${done}/${src.rows.length}`)
      return { ...r, judge: v }
    })
    process.stdout.write('\n')
    const ok = rows.filter((r) => !r.error)
    const correct = ok.filter((r) => r.judge === 'CORRECT').length
    const byType = {}
    for (const r of ok) { byType[r.type] = byType[r.type] || { n: 0, correct: 0 }; byType[r.type].n++; if (r.judge === 'CORRECT') byType[r.type].correct++ }
    console.log(`    重判后：${correct}/${ok.length} = ${((correct / ok.length) * 100).toFixed(1)}%（原单次裁判 ${src.accuracyPct}%）`)
    for (const [t, v] of Object.entries(byType)) console.log(`      ${t}: ${v.correct}/${v.n}`)
    const outFile = path.join(REPORTS, rejudge.replace(/\.json$/, `-rejudge${votes}.json`))
    fs.writeFileSync(outFile, JSON.stringify({ ...src, judgeVotes: votes, accuracyPct: Number(((correct / ok.length) * 100).toFixed(2)), correct, rows, rejudgedAt: new Date().toISOString(), usage: { judge: judge.describe() } }, null, 2))
    console.log(`    产物 → ${path.relative(path.join(EXT, '..', '..'), outFile)}；裁判调用 ${judge.describe().calls} 次，约 ¥${judge.describe().estimatedCostCNY}`)
    return
  }

  const variantKey = arg('--variant', 'A1')
  const which = arg('--split', 'dev')
  const variant = VARIANTS[variantKey]
  if (!variant) throw new Error(`未知变体 ${variantKey}`)

  const questions = loadQuestions()
  const split = ensureSplit(questions)
  const ids = new Set(split[which])
  const tasks = questions.filter((q) => ids.has(q.id))
  console.log(`=== FinanceBench 实验 · 变体 ${variantKey} · 切分 ${which}（${tasks.length} 题，哈希 ${split.hash[which].slice(0, 12)}）===`)
  console.log(`    ${variant.label}`)
  if (which === 'test') console.log('    ⚠️ 这是最终验证切分：只应跑一次，结果无论好坏都要如实记录')

  // baseline 在同一批题号上的表现
  const base = baselineRows().filter((r) => ids.has(r.id))
  const baseCorrect = base.filter((r) => r.grade.judge === 'CORRECT').length
  console.log(`    baseline（同题号 n=${base.length}）：裁判判对 ${baseCorrect} → ${((baseCorrect / Math.max(1, base.length)) * 100).toFixed(1)}%`)

  const client = new ModelClient({ model: arg('--model', 'deepseek-flash') })
  const judge = new ModelClient({ model: arg('--judge', 'deepseek-flash') })
  const judgeVotes = Number(arg('--judge-votes', 1))
  const rows = []
  let done = 0
  await mapLimit(tasks, Number(arg('--concurrency', 4)), async (t) => {
    const t0 = Date.now()
    try {
      let pred = ''
      let ev = t.evidence
      let evStats = null
      if (variant.preprocess) {
        const r = variant.preprocess(ev)
        ev = r.markdown
        evStats = r.stats
      }
      if (variant.structureStage) {
        const st = await client.chat({ system: STRUCTURE_SYS, user: structureUser(ev), maxTokens: 4096, kind: 'exp-structure' })
        if (st.text && st.text.length > 200) ev = st.text
      }
      if (variant.twoStage) {
        const stage1 = await client.chat({
          system: 'You extract figures from financial filings. Output only the extracted lines, no commentary.',
          user: `From the document evidence below, extract every line item relevant to the question, with its period and unit. Output one per line as "<line item>: <value> <unit> (<period>)".

[Question]
${t.question}

[Document evidence]
${ev}`,
          maxTokens: 2048, kind: 'exp-stage1',
        })
        const stage2 = await client.chat({
          system: 'You are a financial analyst. Answer strictly from the extracted figures provided.',
          user: `[Question]\n${t.question}\n\n[Extracted figures from the filing]\n${stage1.text}\n\nGive the final answer with its unit.`,
          maxTokens: 1536, kind: 'exp-stage2',
        })
        pred = stage2.text
      } else {
        const r = await client.chat({ system: variant.system, user: variant.user(t.question, ev), maxTokens: 2048, kind: `exp-${variantKey}` })
        pred = r.text
      }
      const verdict = await judgeWithVotes(judge, { question: t.question, gold: t.gold, pred }, judgeVotes)
      const det = G.numericMatch(pred, t.gold)
      const isNum = /^-?\$?\s?[\d,]+(\.\d+)?%?$/.test(t.gold.trim())
      done++
      if (done % 10 === 0) process.stdout.write(`\r    进度 ${done}/${tasks.length}`)
      rows.push({
        id: t.id, type: t.type, gold: t.gold, prediction: pred.slice(0, 800), judge: verdict,
        deterministic: isNum && det ? det.hit : G.normChars(pred).includes(G.normChars(t.gold)),
        evidenceStats: evStats ? { tables: evStats.tables, rows: evStats.rows, periods: evStats.periodCount, preserved: evStats.numbersPreserved } : undefined,
        ms: Date.now() - t0, error: null,
      })
    } catch (e) {
      rows.push({ id: t.id, type: t.type, gold: t.gold, prediction: '', judge: 'ERROR', deterministic: false, error: String(e.message).slice(0, 200) })
    }
  })
  process.stdout.write('\n')

  const ok = rows.filter((r) => !r.error)
  const correct = ok.filter((r) => r.judge === 'CORRECT').length
  const byType = {}
  for (const r of ok) {
    byType[r.type] = byType[r.type] || { n: 0, correct: 0, base: 0 }
    byType[r.type].n++
    if (r.judge === 'CORRECT') byType[r.type].correct++
    const b = base.find((x) => x.id === r.id)
    if (b && b.grade.judge === 'CORRECT') byType[r.type].base++
  }
  const delta = ok.length ? correct - baseCorrect : 0
  console.log(`\n    结果：裁判判对 ${correct}/${ok.length} = ${((correct / ok.length) * 100).toFixed(1)}%`)
  console.log(`    相对 baseline（同题号 ${baseCorrect}/${base.length}）：${delta >= 0 ? '+' : ''}${delta} 题 = ${((delta / Math.max(1, ok.length)) * 100).toFixed(1)}pp`)
  for (const [t, v] of Object.entries(byType)) {
    console.log(`      ${t}: ${v.correct}/${v.n}（baseline ${v.base}/${v.n}）`)
  }
  const refusal = ok.filter((r) => r.judge === 'REFUSAL').length
  const detOk = ok.filter((r) => r.deterministic).length
  console.log(`    拒答 ${refusal} 题；确定性判分判对 ${detOk} 题`)

  const file = path.join(REPORTS, `exp-${variantKey}-${which}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.writeFileSync(file, JSON.stringify({
    variant: variantKey, label: variant.label, split: which, n: ok.length, correct,
    accuracyPct: Number(((correct / ok.length) * 100).toFixed(2)),
    baselinePct: Number(((baseCorrect / Math.max(1, base.length)) * 100).toFixed(2)),
    deltaQuestions: delta, refusal, deterministicCorrect: detOk,
    byType, splitHash: split.hash[which], rows,
    usage: { author: client.describe(), judge: judge.describe() },
  }, null, 2))
  console.log(`    产物 → ${path.relative(path.join(EXT, '..', '..'), file)}`)
  const cost = (client.describe().estimatedCostCNY || 0) + (judge.describe().estimatedCostCNY || 0)
  console.log(`    记账：author ${client.describe().calls} 次 + judge ${judge.describe().calls} 次，约 ¥${cost.toFixed(3)}`)
})().catch((e) => { console.error(e); process.exit(1) })

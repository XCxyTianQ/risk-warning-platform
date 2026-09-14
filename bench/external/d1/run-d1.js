/**
 * D1 · 端到端文档问答（open-book 口径）。
 *
 * 与之前所有 FinanceBench 实验的区别：**不再喂论文标注的证据段落**，而是给整篇 10-K
 * （我们自己的 PDF 抽取文本），由检索先找段落、再作答。这才是平台文档问答的真实链路。
 *
 * 两个必须分开报的数字：
 *  - 检索命中率：被选中的段落里是否包含论文标注的支撑证据（拿 evidence 当真值）→ 检索的锅
 *  - 答题准确率：judge@3 → 模型的锅
 * 否则"分数掉下来"到底是检索没找到还是模型读不懂，说不清。
 *
 *   node bench/external/d1/run-d1.js --split dev --k 8 --judge-votes 3
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const K = require('../lib/kit')
const { buildRetriever, retrievalHit } = require('./retrieval')
const { ModelClient, mapLimit } = require('../lib/model')

const EXT = path.join(__dirname, '..')
const TXT_DIR = path.join(EXT, 'cache', 'raw', 'financebench_text')
const REPORTS = path.join(EXT, 'out', 'experiments')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
fs.mkdirSync(REPORTS, { recursive: true })

// 与 A1 完全相同的作答提示词（唯一差别是证据来自检索而非论文标注）
const A1_SYS = 'You are a financial analyst answering questions about corporate filings. Be concise and factual.'
const A1_USER = (q, ev) => `Answer the following question using ONLY the document evidence provided below. The evidence is an excerpt from the company's own filing and it always contains the information needed to answer. If the answer is not stated verbatim, derive it from the evidence rather than declining. Give a concise answer.

[Question]
${q}

[Document evidence]
${ev}`

async function judgeWithVotes(judge, { question, gold, pred }, votes) {
  const once = () => judge.chat({ system: 'You are a strict grader. Output exactly one word.', user: K.judgePrompt({ question, gold, pred }), maxTokens: 2048, kind: 'd1-judge' }).then((r) => K.parseJudgeVerdict(r.text)).catch(() => 'ERROR')
  if (votes <= 1) return once()
  const all = await Promise.all(Array.from({ length: votes }, once))
  const tally = {}
  for (const v of all) tally[v] = (tally[v] || 0) + 1
  return Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] === 'INCORRECT' ? -1 : 1))[0][0]
}

;(async () => {
  const split = arg('--split', 'dev')
  const k = Number(arg('--k', 8))
  const votes = Number(arg('--judge-votes', 3))
  const model = arg('--model', 'deepseek-flash')
  const chunkSize = Number(arg('--chunk-size', 1400))
  const evidenceCap = Number(arg('--evidence-cap', 40000))
  const rerank = process.argv.includes('--rerank')
  const recallK = Number(arg('--recall-k', 24))

  const questions = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows.map((r) => ({
    id: r.financebench_id,
    doc: r.doc_name,
    type: r.question_type,
    question: r.question,
    gold: String(r.answer),
    evidence: (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n'),
  }))
  const splitFile = path.join(EXT, 'out', 'financebench-split.json')
  const sp = JSON.parse(fs.readFileSync(splitFile, 'utf8'))
  const ids = new Set(split === 'all' ? [...sp.dev, ...sp.test] : sp[split])
  const tasks = questions.filter((q) => ids.has(q.id))

  const byDoc = new Map()
  for (const t of tasks) {
    if (!byDoc.has(t.doc)) byDoc.set(t.doc, [])
    byDoc.get(t.doc).push(t)
  }
  console.log(`=== D1 端到端文档问答 · 切分 ${split} · ${tasks.length} 题 / ${byDoc.size} 份文档 · 检索 top-${k} · 裁判投票 ${votes} ===`)

  const client = new ModelClient({ model })
  const judge = new ModelClient({ model })
  const rows = []
  let done = 0
  let docMissing = 0

  for (const [doc, qs] of byDoc) {
    const txtFile = path.join(TXT_DIR, `${doc}.txt`)
    if (!fs.existsSync(txtFile)) { docMissing += qs.length; console.log(`  ⚠️ 缺少抽取文本：${doc}`); continue }
    const text = fs.readFileSync(txtFile, 'utf8')
    const retriever = buildRetriever(text, { size: chunkSize, overlap: 200, rerank })
    const chunks = retriever.chunks
    await mapLimit(qs, Number(arg('--concurrency', 4)), async (t) => {
      const t0 = Date.now()
      try {
        const picked = retriever.topK(t.question, k, { recallK })
        const evidence = picked.map((p) => p.text).join('\n\n---\n\n').slice(0, evidenceCap)
        const ret = retrievalHit(evidence, t.evidence)
        const r = await client.chat({ system: A1_SYS, user: A1_USER(t.question, evidence), maxTokens: 2048, kind: 'd1-answer' })
        const verdict = await judgeWithVotes(judge, { question: t.question, gold: t.gold, pred: r.text }, votes)
        done++
        if (done % 10 === 0) process.stdout.write(`\r  进度 ${done}/${tasks.length}（当前文档 ${doc}）          `)
        rows.push({
          id: t.id, doc, type: t.type, gold: t.gold, prediction: r.text.slice(0, 800), judge: verdict,
          retrieval: { k, hit: ret.hit, coverage: Number(ret.coverage.toFixed(3)), chunkIndexes: picked.map((p) => p.index), topScore: Number((picked[0] ? picked[0].score : 0).toFixed(2)) },
          evidenceChars: evidence.length, docChars: text.length, chunks: chunks.length,
          ms: Date.now() - t0, error: null,
        })
      } catch (e) {
        rows.push({ id: t.id, doc, type: t.type, gold: t.gold, prediction: '', judge: 'ERROR', retrieval: null, ms: Date.now() - t0, error: String(e.message).slice(0, 200) })
      }
    })
  }
  process.stdout.write('\n')

  const ok = rows.filter((r) => !r.error)
  const correct = ok.filter((r) => r.judge === 'CORRECT').length
  const hit = ok.filter((r) => r.retrieval && r.retrieval.hit).length
  const byType = {}
  for (const r of ok) {
    byType[r.type] = byType[r.type] || { n: 0, correct: 0, hit: 0 }
    byType[r.type].n++
    if (r.judge === 'CORRECT') byType[r.type].correct++
    if (r.retrieval && r.retrieval.hit) byType[r.type].hit++
  }
  const meanCov = ok.length ? ok.reduce((s, r) => s + (r.retrieval ? r.retrieval.coverage : 0), 0) / ok.length : 0
  console.log(`\n  答题准确率：${correct}/${ok.length} = ${((correct / ok.length) * 100).toFixed(1)}%`)
  console.log(`  检索命中（含标准证据段）：${hit}/${ok.length} = ${((hit / ok.length) * 100).toFixed(1)}%；平均证据覆盖率 ${(meanCov * 100).toFixed(1)}%`)
  for (const [t, v] of Object.entries(byType)) console.log(`    ${t}: 答题 ${v.correct}/${v.n}，检索命中 ${v.hit}/${v.n}`)
  if (docMissing) console.log(`  ⚠️ 因缺少抽取文本而跳过的题：${docMissing}`)
  console.log(`  平均每题 ${Math.round(ok.reduce((s, r) => s + r.ms, 0) / Math.max(1, ok.length))} ms；输入证据平均 ${Math.round(ok.reduce((s, r) => s + (r.evidenceChars || 0), 0) / Math.max(1, ok.length))} 字`)

  const file = path.join(REPORTS, `d1-${split}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.writeFileSync(file, JSON.stringify({
    variant: 'D1', label: `D1 端到端文档问答（${rerank ? `召回${recallK}→重排${k}` : `加权 top-${k}`}，整篇 10-K）`, split, n: ok.length, correct,
    accuracyPct: Number(((correct / ok.length) * 100).toFixed(2)),
    retrievalHitPct: Number(((hit / ok.length) * 100).toFixed(2)), meanEvidenceCoverage: Number(meanCov.toFixed(3)),
    k, rerank, recallK: rerank ? recallK : null, judgeVotes: votes, byType, rows, splitHash: sp.hash[split === 'all' ? 'dev' : split],
    usage: { author: client.describe(), judge: judge.describe() },
  }, null, 2))
  console.log(`  产物 → ${path.relative(path.join(EXT, '..', '..'), file)}`)
  console.log(`  成本：作答 ${client.describe().calls} 次 + 裁判 ${judge.describe().calls} 次 ≈ ¥${((client.describe().estimatedCostCNY || 0) + (judge.describe().estimatedCostCNY || 0)).toFixed(3)}`)
})().catch((e) => { console.error(e); process.exit(1) })

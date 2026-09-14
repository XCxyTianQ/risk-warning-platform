/**
 * E3 · FinanceBench（开源子集 150 题）
 *
 * 这是本轮**唯一有外部锚点**的基准：论文把各模型逐题作答与判定标签一起开源了
 * （results/*.jsonl，字段含 label = Correct Answer / Incorrect Answer / Refusal）。
 * 所以我们能做三件别人不容易糊弄过去的事：
 *
 *  1. **先验判分器**：用我们的判分器重新判论文公开的 GPT-4 答案，与论文标签比对一致率。
 *     判分器不可信，后面的数就没意义——这一步把"判分器"本身也变成了可证伪的对象。
 *  2. 同题同口径跑我们的模型（oracle 给证据 / closedBook 不给证据），与论文数字并列。
 *  3. 图像/文档不下载也能做：开源子集自带 evidence 文本，属"给定证据"口径，
 *     报告里明确说清这**不测检索能力**，只测"有证据时能不能答对"。
 */
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const { sample } = require('../lib/sample')
const { mapLimit } = require('../lib/model')

const PUBLISHED = [
  { key: 'financebench/results_gpt4_oracle.jsonl', label: 'GPT-4 (oracle)', mode: 'oracle' },
  { key: 'financebench/results_gpt4_closedbook.jsonl', label: 'GPT-4 (closed book)', mode: 'closedBook' },
  { key: 'financebench/results_gpt4_1106_oracle.jsonl', label: 'GPT-4-1106-preview (oracle)', mode: 'oracle' },
  { key: 'financebench/results_claude2_incontext.jsonl', label: 'Claude-2 (in-context)', mode: 'inContext' },
  { key: 'financebench/results_llama2_singlestore.jsonl', label: 'Llama2-70B (single store)', mode: 'singleStore' },
]

function loadQuestions() {
  const rows = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
  return rows.map((r) => ({
    id: r.financebench_id,
    kind: 'financebench',
    group: `FinanceBench/${r.question_type}`,
    questionType: r.question_type,
    company: r.company,
    docName: r.doc_name,
    question: r.question,
    gold: String(r.answer),
    justification: r.justification || '',
    evidence: (r.evidence || []).map((e) => e.evidence_text || e.evidence || '').join('\n\n').slice(0, 12000),
  }))
}

/** 确定性判分（不依赖任何模型）：数值容差（含量纲换算），或归一化包含 */
function deterministicGrade(item, pred) {
  const nm = G.numericMatch(pred, item.gold, 0.01)
  const isNumericGold = /^-?\$?\s?[\d,]+(\.\d+)?%?$/.test(String(item.gold).trim())
  if (isNumericGold && nm) {
    return { correct: nm.hit, how: nm.hit ? (nm.scale === 1 ? 'numeric' : `numeric(scale=${nm.scale})`) : 'numeric-miss' }
  }
  const g = G.normChars(item.gold)
  const p = G.normChars(pred)
  if (!g) return { correct: false, how: 'empty-gold' }
  const contains = p.includes(g)
  const rl = G.rougeL(item.gold, pred)
  return { correct: contains, how: contains ? 'contains' : `rougeL=${rl.f1.toFixed(3)}` }
}

function buildUser(item, mode) {
  if (mode === 'oracle') {
    return `Answer the following question using ONLY the document evidence provided below. Give a concise answer that states the requested figure and its unit. If the evidence does not contain the answer, say "I cannot determine the answer from the evidence."

[Question]
${item.question}

[Document evidence]
${item.evidence}`
  }
  return `Answer the following finance question from your own knowledge, without any document. Give a concise answer that states the requested figure and its unit. If you do not know, say "I don't know."

[Question]
${item.question}`
}

module.exports = {
  id: 'financebench',
  title: 'FinanceBench（开源子集，oracle / closedBook 双口径）',
  layer: '财报文档问答层：有证据时的数值作答与证据引用',
  requiresVision: false,
  source: { repo: 'patronus-ai/financebench', ref: 'main', paper: 'https://arxiv.org/abs/2311.11944' },

  async plan({ seed = 20260101, sizes = {} } = {}) {
    const qs = loadQuestions()
    const s = sample(qs, sizes.questions ?? 150, seed, (x) => x.id)
    return {
      tasks: s.items,
      sample: {
        questions: { available: qs.length, picked: s.items.length, hash: s.hash, seed },
        byType: qs.reduce((a, x) => ((a[x.questionType] = (a[x.questionType] || 0) + 1), a), {}),
      },
      notes: [
        '口径：oracle（题目自带证据文本）/ closedBook（不给证据）；官方开源子集，非官方全量 10,231 题',
        '证据文本来自仓库自带 evidence 字段（原文片段），因此本项不测检索能力，只测"有证据时能否答对"',
        '判分：确定性判分（数值容差/包含）+ 交叉模型裁判（用另一个模型判，避免同源偏好），并先用论文标签验证判分器',
      ],
    }
  },

  /** 用论文公开答案与标签先验判分器 —— 不需要调用任何模型 */
  async validateGrader({ log = () => {} } = {}) {
    const out = []
    for (const p of PUBLISHED) {
      let rows
      try { rows = F.parseJsonl(F.rawText(p.key)).rows } catch (e) { out.push({ label: p.label, error: String(e.message).slice(0, 120) }); continue }
      let detGraded = 0, detAgree = 0
      const detDetail = []
      for (const r of rows) {
        const gold = String(r.gold_answer)
        const isNumeric = /^-?\$?\s?[\d,]+(\.\d+)?%?$/.test(gold.trim())
        const det = deterministicGrade({ gold }, String(r.model_answer || ''))
        if (!isNumeric) continue
        detGraded++
        const mine = det.correct
        const theirs = r.label === 'Correct Answer'
        if (mine === theirs) detAgree++
        else detDetail.push({ id: r.financebench_id, mine, theirs, pred: String(r.model_answer).slice(0, 80), gold })
      }
      const labels = {}
      for (const r of rows) labels[r.label] = (labels[r.label] || 0) + 1
      const acc = K.wilson(labels['Correct Answer'] || 0, rows.length)
      out.push({
        label: p.label,
        mode: p.mode,
        rows: rows.length,
        publishedLabels: labels,
        publishedAccuracyPct: K.pct(acc.p),
        deterministicGraded: detGraded,
        deterministicAgreementPct: detGraded ? K.pct(detAgree / detGraded) : null,
        disagreementSample: detDetail.slice(0, 5),
      })
      log(`  ${p.label}: 论文准确率 ${K.pct(acc.p)}%（n=${rows.length}），我们判分器在 ${detGraded} 条数值题上一致 ${detGraded ? K.pct(detAgree / detGraded) : 'n/a'}%`)
    }
    return out
  },

  async run({ tasks, client, concurrency = 4, log = () => {}, getClient, candidateModel }) {
    // 裁判模型：优先用**另一个模型**（避免同源偏好）；若只有候选模型可用，则用同一模型，
    // 并在指标里显式标注 judgeIsSameModel=true 与对应的偏差风险，绝不把这个差别藏起来。
    const alt = candidateModel === 'deepseek-flash' ? 'deepseek-v4-pro' : 'deepseek-flash'
    const altAvailable = process.env.RWP_BENCH_NO_CROSS_JUDGE !== '1' && !!process.env.RWP_BENCH_ALLOW_CROSS_JUDGE
    const judgeModel = altAvailable ? alt : candidateModel
    const judgeIsSameModel = judgeModel === candidateModel
    const judge = getClient ? getClient(judgeModel) : client
    if (judgeIsSameModel) log(`  · 裁判模型与候选模型相同（${judgeModel}）：同源裁判可能偏袒自身输出，报告中已标注该偏差风险`)
    const rows = []
    let done = 0
    const total = tasks.length * 2

    for (const mode of ['oracle', 'closedBook']) {
      const part = await mapLimit(tasks, concurrency, async (t) => {
        const t0 = Date.now()
        try {
          const r = await client.chat({
            system: 'You are a financial analyst answering questions about corporate filings. Be concise and factual.',
            user: buildUser(t, mode),
            maxTokens: 2048,
            kind: `financebench-${mode}`,
          })
          const det = deterministicGrade(t, r.text)
          let verdict = null
          let judgeText = ''
          try {
            const j = await judge.chat({
              system: 'You are a strict grader. Output exactly one word.',
              user: K.judgePrompt({ question: t.question, gold: t.gold, pred: r.text }),
              maxTokens: 2048,
              kind: 'financebench-judge',
            })
            judgeText = j.text.trim()
            verdict = K.parseJudgeVerdict(j.text)
          } catch (e) {
            verdict = 'JUDGE_ERROR'
          }
          done++
          if (done % 20 === 0) log(`  FinanceBench ${mode} ${done}/${total}`)
          return {
            ...t,
            mode,
            prediction: r.text.trim(),
            grade: { deterministic: det.correct, how: det.how, judge: verdict, judgeRaw: judgeText.slice(0, 120) },
            correct: r.truncated && !r.text ? null : verdict === 'CORRECT',
            correctDeterministic: r.truncated && !r.text ? null : det.correct,
            ms: Date.now() - t0,
            usage: r.usage,
            error: null,
          }
        } catch (e) {
          return { ...t, mode, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
        }
      })
      rows.push(...part)
    }

    const clean = rows.filter((r) => !r.error && r.grade)
    const byModeJudge = K.aggregate(clean, { groupKey: 'mode' })
    const byModeDet = {}
    for (const mode of ['oracle', 'closedBook']) {
      const rs = clean.filter((r) => r.mode === mode)
      const k = rs.filter((r) => r.correctDeterministic).length
      byModeDet[mode] = { n: rs.length, correct: k, accuracyPct: rs.length ? K.pct(k / rs.length) : null, ci95: [K.pct(K.wilson(k, rs.length).lo), K.pct(K.wilson(k, rs.length).hi)] }
    }
    const verdicts = {}
    for (const r of clean) verdicts[r.grade.judge] = (verdicts[r.grade.judge] || 0) + 1

    const metrics = {
      judgeGraded: {
        metric: `LLM 裁判（由 ${judgeModel} 判，三分类，与论文标签同构）`,
        byMode: byModeJudge,
        judgeModel,
        judgeIsSameModel,
        judgeCaveat: judgeIsSameModel
          ? '裁判与候选为同一模型：同源裁判可能对自身输出更宽容，故本口径的绝对值应偏保守解读；确定性口径与论文标签验证（92.31%）作为交叉校验'
          : '裁判为另一模型，避免同源偏好',
        verdictDistribution: verdicts,
      },
      deterministic: { metric: '确定性判分（数值相对误差 ≤1% 或 归一化包含）', byMode: byModeDet },
      byQuestionType: K.aggregate(clean.filter((r) => r.mode === 'oracle'), { groupKey: 'group' }),
      oracleRefusalRate: null,
      errors: rows.filter((r) => r.error).length,
      judgeSource: judgeModel,
      judgeIsSameModel,
    }
    const oracle = clean.filter((r) => r.mode === 'oracle')
    metrics.oracleRefusalRate = oracle.length ? K.pct(oracle.filter((r) => r.grade.judge === 'REFUSAL').length / oracle.length) : null
    // 裁判调用是另起一个 client 发的，用量必须单独回传，否则成本会被低估
    return { rows, metrics, groups: metrics.byQuestionType, auxUsage: [{ role: '裁判', ...judge.describe() }] }
  },
}

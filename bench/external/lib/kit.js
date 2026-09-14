/**
 * 评测用的小工具集：
 *  - BFCL 的函数描述（Python 口径："type":"dict"/"float"）转成 OpenAI tools 口径
 *  - LLM 裁判的提示词（口径与 FinanceBench 论文一致：Correct / Incorrect / Refusal）
 *  - 结果聚合（准确率 + 95% 置信区间），报告里所有比例都必须带区间
 */

/** BFCL/FinEval 的 Python 类型 → JSON Schema 类型 */
const TYPE_MAP = { dict: 'object', float: 'number', integer: 'integer', string: 'string', boolean: 'boolean', array: 'array', tuple: 'array', any: 'string', list: 'array' }

function toJsonSchemaType(t) { return TYPE_MAP[t] || 'string' }

/**
 * 把 BFCL 的函数描述转成 OpenAI tools 参数。
 * 注意：这是**保真度关键点**——官方 pipeline 对 API 模型也做同样的转换（convert_to_openai_tool），
 * 我们把转换实现固定下来并记录在报告里，避免"因为 schema 不合法导致模型答不出来"的假失败。
 */
function toOpenAITools(funcDescriptions) {
  return funcDescriptions.map((f) => {
    const props = (f.parameters && f.parameters.properties) || {}
    const outProps = {}
    for (const [k, v] of Object.entries(props)) {
      const p = { type: toJsonSchemaType(v.type) }
      if (v.description) p.description = String(v.description)
      if (v.enum) p.enum = v.enum
      if (v.type === 'array' || v.type === 'tuple' || v.type === 'list') {
        const it = v.items || {}
        p.items = { type: toJsonSchemaType(it.type) }
      }
      outProps[k] = p
    }
    return {
      type: 'function',
      function: {
        name: String(f.name).replace(/\./g, '_'),
        description: String(f.description || '').slice(0, 1024),
        parameters: { type: 'object', properties: outProps, required: (f.parameters && f.parameters.required) || [] },
      },
    }
  })
}

/** FinanceBench / 通用问答的裁判提示词（输出三分类，与论文标签对齐） */
function judgePrompt({ question, gold, pred }) {
  return `You are comparing a submitted answer to an expert answer on a given question.

[BEGIN DATA]
************
[Question]: ${question}
************
[Expert Answer]: ${gold}
************
[Submitted Answer]: ${pred}
************
[END DATA]

Compare the factual content of the submitted answer with the expert answer. Ignore differences in
style, grammar, or punctuation. Numbers may be written differently (e.g. "$1,577 million" vs "1577"
vs "1.577 billion"), and an answer that states the same quantity is CORRECT.

If the submitted answer states it cannot determine the answer, that it lacks the required document,
or otherwise declines to answer, output REFUSAL.

Reply with exactly one word: CORRECT, INCORRECT, or REFUSAL.`;
}

/** 把裁判输出归一成三分类 */
function parseJudgeVerdict(text) {
  const t = String(text || '').toUpperCase()
  if (/\bREFUSAL\b|\bREFUSE\b/.test(t)) return 'REFUSAL'
  if (/\bINCORRECT\b|\bWRONG\b/.test(t)) return 'INCORRECT'
  if (/\bCORRECT\b/.test(t)) return 'CORRECT'
  // 兜底：取第一个出现的判定词
  const m = t.match(/(CORRECT|INCORRECT|REFUSAL)/)
  return m ? m[1] : 'UNPARSED'
}

/** Wilson 区间（比例 + 95% CI），样本量小时比正态近似稳 */
function wilson(k, n, z = 1.96) {
  if (!n) return { p: null, lo: null, hi: null, n: 0, k: 0 }
  const p = k / n
  const d = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half), n, k }
}

const pct = (x) => (x === null || x === undefined ? null : Number((x * 100).toFixed(2)))

/** 分组聚合：rows 需含 {group, correct} —— correct 为 true/false/null(弃权/未判定) */
function aggregate(rows, { groupKey = 'group', correctKey = 'correct' } = {}) {
  const byGroup = new Map()
  const bump = (key, r) => {
    const g = byGroup.get(key) || { group: key, n: 0, correct: 0, wrong: 0, abstain: 0, ungraded: 0 }
    g.n++
    if (r[correctKey] === true) g.correct++
    else if (r[correctKey] === false) g.wrong++
    else if (r[correctKey] === null || r[correctKey] === undefined) g.abstain++
    else g.ungraded++
    byGroup.set(key, g)
  }
  for (const r of rows) {
    bump('__ALL__', r)
    if (groupKey && r[groupKey] !== undefined) bump(String(r[groupKey]), r)
  }
  const groups = {}
  for (const [k, v] of byGroup) {
    const ci = wilson(v.correct, v.n)
    groups[k] = { ...v, accuracy: ci.p === null ? null : pct(ci.p), accuracyPct: pct(ci.p), ci95: [pct(ci.lo), pct(ci.hi)] }
  }
  return groups
}

module.exports = { toOpenAITools, judgePrompt, parseJudgeVerdict, wilson, pct, aggregate }

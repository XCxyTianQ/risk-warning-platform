/**
 * 提示词敏感性实验：我们的成绩里有多少来自"提示词"？
 *
 * 背景：CFLUE 知识题我们写了"只输出答案字母，不要解释"这样的系统提示。
 * 严格说起来，这既降低了格式遵循难度，也可能影响正确率。
 * 与其在报告里含糊其辞，不如直接把两种提示词下的结果都跑出来：
 *   A 严格提示：只输出答案字母
 *   B 中性提示：请回答问题（不限制格式）
 *   C 思考提示：请先思考再给出答案（允许推理）
 *
 *   node bench/external/tools/probe-prompt-sensitivity.js --n 60
 */
const G = require('../lib/grade')
const { ModelClient, mapLimit } = require('../lib/model')
const { sample } = require('../lib/sample')
const F = require('../lib/fetch')
const path = require('node:path')
const fs = require('node:fs')

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

const VARIANTS = [
  { id: 'strict', label: '严格提示（只输出字母）', system: '你是金融领域知识评测的答题者。只输出答案字母，不要任何解释、不要复述题目。' },
  { id: 'neutral', label: '中性提示（不限格式）', system: '你是金融领域的知识助手，请回答下面的题目。' },
  { id: 'reasoned', label: '思考提示（允许推理）', system: '你是金融领域知识评测的答题者。请先简要分析，再在最后一行给出答案字母。' },
]

const TASK_HINT = {
  单项选择题: '本题为单项选择题，有且只有一个正确答案。',
  多项选择题: '本题为多项选择题，可能有多个正确答案，请输出全部正确选项的字母（例如 ABD，字母间不要加空格）。',
  判断题: '本题为判断题，A 表示"对"，B 表示"错"。',
}

const CJK = /[\u4e00-\u9fff]/

;(async () => {
  const n = Number(arg('--n', 60))
  const seed = Number(arg('--seed', 20260101))
  const model = arg('--model', 'deepseek-flash')
  const rows = JSON.parse(F.rawText('cflue/knowledge.json'))
  const items = rows.map((r, i) => {
    const choices = []
    const re = /'([A-H])'\s*:\s*'((?:[^'\\]|\\.)*)'/g
    let m
    while ((m = re.exec(r.choices))) choices.push({ key: m[1], text: m[2] })
    return { id: `knowledge_${i}`, taskType: r.task, question: r.question, choices, gold: String(r.answer).trim() }
  }).filter((x) => x.choices.length >= 2)
  const picked = sample(items, n, seed, (x) => x.id).items

  console.log(`提示词敏感性实验 · ${model} · ${picked.length} 题（样本哈希 ${sample(items, n, seed, (x) => x.id).hash.slice(0, 12)}）`)
  const client = new ModelClient({ model })
  const out = { model, n: picked.length, seed, variants: {} }

  for (const v of VARIANTS) {
    let done = 0
    const res = await mapLimit(picked, 6, async (t) => {
      const opts = t.choices.map((c) => `${c.key}. ${c.text}`).join('\n')
      const user = `${TASK_HINT[t.taskType] || ''}\n\n题目：${t.question}\n选项：\n${opts}`
      try {
        const r = await client.chat({ system: v.system, user, maxTokens: 2048, kind: `sensitivity-${v.id}` })
        const g = G.gradeMcq(r.text, t.gold)
        done++
        if (done % 20 === 0) process.stdout.write(`\r  [${v.id}] ${done}/${picked.length}`)
        return { id: t.id, taskType: t.taskType, gold: t.gold, predicted: g.letters, how: g.how, correct: g.correct, outChars: r.text.length, truncated: r.truncated }
      } catch (e) {
        return { id: t.id, error: String(e.message).slice(0, 200), correct: null }
      }
    })
    process.stdout.write('\n')
    const clean = res.filter((r) => !r.error)
    const correct = clean.filter((r) => r.correct).length
    const modes = {}
    for (const r of clean) modes[r.how] = (modes[r.how] || 0) + 1
    const meanChars = clean.length ? Math.round(clean.reduce((s, r) => s + r.outChars, 0) / clean.length) : 0
    out.variants[v.id] = {
      label: v.label,
      system: v.system,
      n: clean.length,
      correct,
      accuracyPct: clean.length ? Number(((correct / clean.length) * 100).toFixed(2)) : null,
      extractMode: modes,
      meanOutputChars: meanChars,
      rows: res,
    }
    console.log(`  ${v.label.padEnd(18)} 准确率 ${out.variants[v.id].accuracyPct}%（n=${clean.length}）  平均输出 ${meanChars} 字  抽取方式 ${JSON.stringify(modes)}`)
  }

  const base = out.variants.strict.accuracyPct
  for (const k of Object.keys(out.variants)) {
    out.variants[k].deltaVsStrict = out.variants[k].accuracyPct === null ? null : Number((out.variants[k].accuracyPct - base).toFixed(2))
  }
  console.log('\n相对严格提示的差值（百分点）：')
  for (const [k, v] of Object.entries(out.variants)) console.log(`  ${v.label.padEnd(18)} ${v.deltaVsStrict > 0 ? '+' : ''}${v.deltaVsStrict}`)

  const file = path.join(__dirname, '..', 'out', 'prompt-sensitivity.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(__dirname, '..', '..', '..'), file)}`)
  console.log(`记账：${JSON.stringify(client.describe())}`)
})()

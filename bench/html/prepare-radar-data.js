/**
 * 雷达图的数据准备：把"同题同口径"的多方数字算出来。
 *
 * 口径把关（这一节是重点）：
 *  - gpt-4_oracle / gpt-4-1106-preview_oracle：论文的 oracle 口径 = 把财报证据给模型 → 与我们一致；
 *  - claude-2_inContext：论文中"把 10-K 放进上下文"的口径，等价于 oracle → 纳入；
 *  - llama2_singleStore / gpt-4_sharedStore：**检索口径**（先检索再回答），条件不同 → 不纳入雷达，
 *    否则会把"检索没命中"算成"模型不会读"；
 *  - gpt-4_closedBook：不给任何文档 → 单独一张小图与我们的闭卷对比。
 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const RAW = path.join(REPO, 'bench', 'external', 'cache', 'raw')
const OUT = path.join(REPO, 'bench', 'external', 'out', 'radar-data.json')

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

const questions = readJsonl(path.join(RAW, 'financebench_open_source.jsonl'))
const typeOf = new Map(questions.map((q) => [q.financebench_id, q.question_type]))
const TYPES = ['metrics-generated', 'domain-relevant', 'novel-generated']

const MODELS = [
  { key: 'financebench_results_gpt4_oracle.jsonl', label: 'GPT-4（oracle）', mode: 'oracle' },
  { key: 'financebench_results_gpt4_1106_oracle.jsonl', label: 'GPT-4-1106（oracle）', mode: 'oracle' },
  { key: 'financebench_results_claude2_incontext.jsonl', label: 'Claude-2（in-context）', mode: 'oracle' },
  { key: 'financebench_results_llama2_singlestore.jsonl', label: 'Llama2-70B（single store）', mode: 'retrieval' },
  { key: 'financebench_results_gpt4_closedbook.jsonl', label: 'GPT-4（闭卷）', mode: 'closedBook' },
]

const out = { generatedAt: new Date().toISOString(), types: TYPES, models: [] }
for (const m of MODELS) {
  const rows = readJsonl(path.join(RAW, m.key))
  const byType = {}
  for (const t of TYPES) byType[t] = { n: 0, correct: 0, refusal: 0 }
  let correct = 0, refusal = 0
  for (const r of rows) {
    const t = typeOf.get(r.financebench_id)
    if (!t || !byType[t]) continue
    byType[t].n++
    if (r.label === 'Correct Answer') { byType[t].correct++; correct++ }
    if (r.label === 'Refusal') { byType[t].refusal++; refusal++ }
  }
  const entry = {
    label: m.label,
    mode: m.mode,
    n: rows.length,
    accuracyPct: Number(((correct / rows.length) * 100).toFixed(2)),
    refusalPct: Number(((refusal / rows.length) * 100).toFixed(2)),
    byType: Object.fromEntries(TYPES.map((t) => [t, { n: byType[t].n, accuracyPct: byType[t].n ? Number(((byType[t].correct / byType[t].n) * 100).toFixed(2)) : null }])),
  }
  out.models.push(entry)
  console.log(`${m.label.padEnd(24)} 总体 ${entry.accuracyPct}%  闭卷/检索口径=${m.mode}`)
  console.log(`   ${TYPES.map((t) => `${t}: ${entry.byType[t].accuracyPct}% (n=${entry.byType[t].n})`).join('  ')}`)
}

// 我们自己的分题型数字（来自评测产物）
const ext = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'reports', 'external-alignment-v1.json'), 'utf8'))
const oursRun = ext.benchmarks.financebench.runs['deepseek-flash']
const ours = oursRun.metrics
const ourByType = ours.byQuestionType || {}
out.ours = {
  label: '本平台（deepseek-flash，oracle）',
  mode: 'oracle',
  n: 150,
  accuracyPct: ours.judgeGraded.byMode.oracle.accuracyPct,
  closedBookPct: ours.judgeGraded.byMode.closedBook.accuracyPct,
  promptVariant: ours.promptVariant || 'A0',
  byType: Object.fromEntries(TYPES.map((t) => {
    const v = ourByType[`FinanceBench/${t}`]
    return [t, { n: v ? v.n : 0, accuracyPct: v ? v.accuracyPct : null }]
  })),
}
console.log(`\n${out.ours.label}（提示词 ${out.ours.promptVariant}）总体 ${out.ours.accuracyPct}%`)
console.log(`   ${TYPES.map((t) => `${t}: ${out.ours.byType[t].accuracyPct}% (n=${out.ours.byType[t].n})`).join('  ')}`)
console.log(`   闭卷 ${out.ours.closedBookPct}%`)

// ---------------------------------------------------------------- 统一裁判口径
// 关键：把论文公开答案送进**我们的裁判**重判，得到"同一把尺子"下的对照分数。
// 否则 82% vs 84% 是两个裁判打出来的分，比较不成立。
const jp = path.join(REPO, 'bench', 'external', 'out', 'judge-published.json')
if (fs.existsSync(jp)) {
  const j = JSON.parse(fs.readFileSync(jp, 'utf8'))
  const sameJudge = { judgeModel: j.judgeModel && j.judgeModel.model, models: [] }
  for (const r of j.results || []) {
    const byType = {}
    for (const t of TYPES) byType[t] = { n: 0, correct: 0 }
    let correct = 0
    for (const row of r.rows || []) {
      const t = typeOf.get(row.id)
      if (!t || !byType[t]) continue
      byType[t].n++
      if (row.ourVerdict === 'CORRECT') { byType[t].correct++; correct++ }
    }
    const n = (r.rows || []).length
    sameJudge.models.push({
      label: r.label,
      paperAccuracyPct: r.paperAccuracyPct,
      ourJudgeAccuracyPct: Number(((correct / Math.max(1, n)) * 100).toFixed(2)),
      n,
      byType: Object.fromEntries(TYPES.map((t) => [t, { n: byType[t].n, accuracyPct: byType[t].n ? Number(((byType[t].correct / byType[t].n) * 100).toFixed(2)) : null }])),
    })
    console.log(`统一裁判：${r.label} 论文 ${r.paperAccuracyPct}% → 我们裁判 ${sameJudge.models[sameJudge.models.length - 1].ourJudgeAccuracyPct}%`)
  }
  out.sameJudge = sameJudge
}

// A1 提示词变体的分题型（dev + test 合计 150 题，来自实验产物）
const expDir = path.join(REPO, 'bench', 'external', 'out', 'experiments')
if (fs.existsSync(expDir)) {
  const files = fs.readdirSync(expDir).filter((f) => /^exp-A1-(dev|test)-.*\.json$/.test(f))
  const rows = []
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(expDir, f), 'utf8'))
    for (const r of j.rows || []) if (!r.error) rows.push(r)
  }
  if (rows.length) {
    const byType = {}
    for (const t of TYPES) byType[t] = { n: 0, correct: 0 }
    for (const r of rows) {
      const t = TYPES.includes(r.type) ? r.type : null
      if (!t) continue
      byType[t].n++
      if (r.judge === 'CORRECT') byType[t].correct++
    }
    const correct = rows.filter((r) => r.judge === 'CORRECT').length
    out.oursA1 = {
      label: '本平台（A1 去保守化提示词）',
      n: rows.length,
      accuracyPct: Number(((correct / rows.length) * 100).toFixed(2)),
      byType: Object.fromEntries(TYPES.map((t) => [t, { n: byType[t].n, accuracyPct: byType[t].n ? Number(((byType[t].correct / byType[t].n) * 100).toFixed(2)) : null }])),
      sources: files,
    }
    console.log(`A1 变体（dev+test 合计 n=${rows.length}）总体 ${out.oursA1.accuracyPct}%`)
    console.log(`   ${TYPES.map((t) => `${t}: ${out.oursA1.byType[t].accuracyPct}%`).join('  ')}`)
  }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\n已写出 ${path.relative(REPO, OUT)}`)

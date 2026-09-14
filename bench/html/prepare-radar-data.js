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
const ours = ext.benchmarks.financebench.runs['deepseek-flash'].metrics
const ourByType = ours.byQuestionType || {}
out.ours = {
  label: '本平台（deepseek-flash，oracle）',
  mode: 'oracle',
  n: 150,
  accuracyPct: ours.judgeGraded.byMode.oracle.accuracyPct,
  closedBookPct: ours.judgeGraded.byMode.closedBook.accuracyPct,
  byType: Object.fromEntries(TYPES.map((t) => {
    const v = ourByType[`FinanceBench/${t}`]
    return [t, { n: v ? v.n : 0, accuracyPct: v ? v.accuracyPct : null }]
  })),
}
console.log(`\n${out.ours.label} 总体 ${out.ours.accuracyPct}%`)
console.log(`   ${TYPES.map((t) => `${t}: ${out.ours.byType[t].accuracyPct}% (n=${out.ours.byType[t].n})`).join('  ')}`)
console.log(`   闭卷 ${out.ours.closedBookPct}%`)

fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\n已写出 ${path.relative(REPO, OUT)}`)

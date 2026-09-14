/**
 * 第五轮探测：FinEval 各文件是否有答案、OmniDocBench demo 的图像在哪、
 * BFCL(JSONL) 的结构、FinanceBench evidence 是否足以支撑"闭卷+证据"两种评测。
 */
const F = require('../lib/fetch')
const fs = require('node:fs')
const path = require('node:path')

const T = {}
for (const f of fs.readdirSync(path.join(__dirname, '..', 'cache', 'trees'))) {
  T[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'trees', f), 'utf8')).tree
}
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : String(o))
const peek = (v, n = 200) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n)
const FE = 'SUFE-AIFLM-Lab/FinEval'

;(async () => {
  console.log('=== FinEval: Financial Rigor Test ===')
  for (const f of ['Financial Rigor Test/Financial Rigor Test_Numerical Calculation.csv']) {
    try {
      const r = await F.fetchText('fineval/' + f.split('/').pop(), F.ghRaw(FE, 'main', f))
      const t = F.parseTable(r.text, ',')
      console.log(`${f}\n  表头: ${t.header.join(' | ')}\n  行数: ${t.rows.length}\n  首行: ${peek(t.rows[0], 400)}`)
    } catch (e) { console.log('  ❌ ' + f + ' ' + e.message) }
  }
  // 索引抽取那 3.8MB 只看表头和前两行，避免整表展开
  try {
    const r = await F.fetchText('fineval/IndexExtraction.csv', F.ghRaw(FE, 'main', 'Financial Rigor Test/Financial Rigor Test_Index Extraction.csv'))
    const head = r.text.split(/\r?\n/).slice(0, 3)
    console.log(`Index Extraction.csv 前 3 行:\n${head.map((l) => '   | ' + l.slice(0, 220)).join('\n')}`)
  } catch (e) { console.log('  ❌ ' + e.message) }

  console.log('\n=== FinEval: security val (可能带答案) ===')
  try {
    const r = await F.fetchText('fineval/websecurity_val.csv', F.ghRaw(FE, 'main', 'code/opensource_eval/34security+agenteval/security/websecurity_val.csv'))
    const t = F.parseTable(r.text, ',')
    console.log(`表头: ${t.header.join(' | ')}\n  行数: ${t.rows.length}\n  首行: ${peek(t.rows[0], 400)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }

  console.log('\n=== FinEval: multimodeldata tsv ===')
  for (const f of ['multimodeldata/Financial Knowledge and Data Analysis/Financial_Indicator_Assessment.tsv', 'multimodeldata/Financial Analysis and Business Decision/Industry_Analysis_and_Inference.tsv']) {
    try {
      const r = await F.fetchText('fineval/' + f.split('/').pop(), F.ghRaw(FE, 'main', f))
      const t = F.parseTable(r.text, '\t')
      console.log(`\n${f}\n  表头: ${t.header.join(' | ')}\n  行数: ${t.rows.length}`)
      console.log(`  首行: ${peek(t.rows[0], 500)}`)
    } catch (e) { console.log('  ❌ ' + f + ' ' + e.message) }
  }

  console.log('\n=== OmniDocBench demo 目录全清单 ===')
  const demo = T.omnidocbench.filter((x) => x.path.startsWith('demo_data/omnidocbench_demo/'))
  const byDir = {}
  for (const x of demo) {
    const d = x.path.replace('demo_data/omnidocbench_demo/', '').split('/').slice(0, -1).join('/') || '.'
    byDir[d] = byDir[d] || { n: 0, b: 0, ex: [] }
    byDir[d].n++; byDir[d].b += x.size || 0
    if (byDir[d].ex.length < 3) byDir[d].ex.push(x.path.split('/').pop())
  }
  for (const [d, v] of Object.entries(byDir)) console.log(`   ${d}: ${v.n} 文件 / ${(v.b / 1024).toFixed(0)}KB  例: ${v.ex.join(', ')}`)
  console.log('   全库图像文件数:', T.omnidocbench.filter((x) => /\.(jpg|jpeg|png)$/i.test(x.path)).length)

  console.log('\n=== BFCL v4 (JSONL) ===')
  try {
    const r = await F.fetchText('bfcl/simple_python.jsonl', F.ghRaw('ShishirPatil/gorilla', 'main', 'berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_simple_python.json'))
    const { rows } = F.parseJsonl(r.text)
    console.log(`BFCL_v4_simple_python: ${rows.length} 条, 字段: ${keys(rows[0])}`)
    console.log(`  样例: ${peek(rows[0], 300)}`)
    console.log(`  function 条数范围: ${Math.min(...rows.map((x) => (x.function || []).length))}~${Math.max(...rows.map((x) => (x.function || []).length))}`)
    const a = await F.fetchText('bfcl/ans_simple_python.jsonl', F.ghRaw('ShishirPatil/gorilla', 'main', 'berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_simple_python.json'))
    const ar = F.parseJsonl(a.text)
    console.log(`可能答案: ${ar.rows.length} 条, 字段: ${keys(ar.rows[0])}`)
    console.log(`  样例: ${peek(ar.rows[0], 300)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }
  try {
    const r = await F.fetchText('bfcl/irrelevance.jsonl', F.ghRaw('ShishirPatil/gorilla', 'main', 'berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_irrelevance.json'))
    const { rows } = F.parseJsonl(r.text)
    console.log(`BFCL_v4_irrelevance: ${rows.length} 条, 字段: ${keys(rows[0])}`)
    console.log(`  样例: ${peek(rows[0], 300)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }

  console.log('\n=== FinanceBench: evidence 完整度 + 论文结果文件结构 ===')
  try {
    const d = await F.fetchText('financebench/open_source.jsonl', F.ghRaw('patronus-ai/financebench', 'main', 'data/financebench_open_source.jsonl'))
    const { rows } = F.parseJsonl(d.text)
    const withEv = rows.filter((r) => (r.evidence || '').trim().length > 0).length
    const evLen = rows.map((r) => (r.evidence || '').length)
    console.log(`  带 evidence 的题目: ${withEv}/${rows.length}; evidence 长度 min/中位/max = ${Math.min(...evLen)}/${evLen.sort((a, b) => a - b)[Math.floor(evLen.length / 2)]}/${Math.max(...evLen)}`)
    const numAns = rows.filter((r) => /^-?\$?[\d,.]+%?$/.test((r.answer || '').trim())).length
    console.log(`  答案为纯数值的题: ${numAns}/${rows.length}`)
    console.log(`  evidence 样例: ${peek(rows[0].evidence, 300)}`)
    console.log(`  justification 样例: ${peek(rows[0].justification, 200)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }
  try {
    const g = await F.fetchText('financebench/results_gpt4_oracle.jsonl', F.ghRaw('patronus-ai/financebench', 'main', 'results/gpt-4_oracle.jsonl'))
    const { rows } = F.parseJsonl(g.text)
    console.log(`  results/gpt-4_oracle.jsonl: ${rows.length} 条, 字段: ${keys(rows[0])}`)
    console.log(`  样例: ${peek(rows[0], 400)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }
})()

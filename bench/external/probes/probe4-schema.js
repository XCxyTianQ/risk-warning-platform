/**
 * 第四轮探测：题目文件的**字段结构**与**答案是否存在**。
 * 没有本地答案 = 只能交卷不能自评，这决定"对齐"能不能做，必须先验证。
 */
const F = require('../lib/fetch')
const path = require('node:path')
const fs = require('node:fs')

const TREES = {}
for (const f of fs.readdirSync(path.join(__dirname, '..', 'cache', 'trees'))) {
  TREES[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'trees', f), 'utf8')).tree
}

function keys(o) { return o && typeof o === 'object' ? Object.keys(o).join(',') : String(o) }
function peek(v, n = 160) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return (s || '').replace(/\s+/g, ' ').slice(0, n)
}

;(async () => {
  // ---------- CFLUE ----------
  console.log('=== CFLUE ===')
  try {
    const k = await F.fetchJson('cflue/knowledge.json', F.ghRaw('aliyun/cflue', 'master', 'data/knowledge/knowledge.json'))
    const arr = Array.isArray(k.json) ? k.json : (k.json.data || k.json.questions || [])
    console.log(`knowledge.json: ${k.bytes} B, 顶层类型 ${Array.isArray(k.json) ? 'array' : 'object'}，条目 ${arr.length}`)
    console.log(`  字段: ${keys(arr[0])}`)
    console.log(`  样例: ${peek(arr[0], 300)}`)
    const withAns = arr.filter((q) => /answer|label|ans|正确答案/i.test(keys(q))).length
    console.log(`  含答案字段的条目: ${withAns}/${arr.length}`)
  } catch (e) { console.log('  ❌ ' + e.message) }

  try {
    const a = await F.fetchJson('cflue/application.json', F.ghRaw('aliyun/cflue', 'master', 'data/application/application.json'))
    const arr = Array.isArray(a.json) ? a.json : (a.json.data || [])
    console.log(`application.json: 条目 ${arr.length}，字段: ${keys(arr[0])}`)
    console.log(`  样例: ${peek(arr[0], 300)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }

  try {
    const s = await F.fetchJson('cflue/submission_example.json', F.ghRaw('aliyun/cflue', 'master', 'submission_example.json'))
    console.log(`submission_example.json: ${peek(s.json, 400)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }

  // compute_score.py 会暴露官方判分口径与答案位置
  try {
    const p = await F.fetchText('cflue/compute_score.py', F.ghRaw('aliyun/cflue', 'master', 'utils/compute_score.py'))
    const lines = p.text.split(/\r?\n/)
    const hints = lines.filter((l) => /answer|label|\.json|acc|score|def /i.test(l)).slice(0, 22)
    console.log('compute_score.py 关键行:')
    hints.forEach((l) => console.log('   | ' + l.trim().slice(0, 130)))
  } catch (e) { console.log('  ❌ ' + e.message) }

  // ---------- FinEval ----------
  console.log('\n=== FinEval（数据文件全清单）===')
  const fe = TREES.fineval.filter((x) => /\.(csv|tsv|json|jsonl)$/i.test(x.path) && !/node_modules|__pycache__/.test(x.path))
  for (const x of fe.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`   ${((x.size || 0) / 1024).toFixed(0).padStart(6)}KB  ${x.path}`)
  }

  // ---------- FinanceBench ----------
  console.log('\n=== FinanceBench ===')
  try {
    const d = await F.fetchText('financebench/open_source.jsonl', F.ghRaw('patronus-ai/financebench', 'main', 'data/financebench_open_source.jsonl'))
    const { rows } = F.parseJsonl(d.text)
    console.log(`open_source.jsonl: ${rows.length} 条，字段: ${keys(rows[0])}`)
    console.log(`  样例: ${peek(rows[0], 500)}`)
    const qt = {}
    for (const r of rows) qt[r.question_type] = (qt[r.question_type] || 0) + 1
    console.log(`  question_type 分布: ${JSON.stringify(qt)}`)
    console.log(`  doc_name 去重: ${new Set(rows.map((r) => r.doc_name)).size} 份文档, 公司 ${new Set(rows.map((r) => r.company)).size} 家`)
  } catch (e) { console.log('  ❌ ' + e.message) }
  const fbResults = TREES.financebench.filter((x) => /results\//.test(x.path))
  console.log('  论文公开结果文件（可作外部对照锚点）:')
  fbResults.forEach((x) => console.log(`     ${((x.size || 0) / 1024).toFixed(0).padStart(5)}KB  ${x.path}`))

  // ---------- OmniDocBench ----------
  console.log('\n=== OmniDocBench ===')
  try {
    const o = await F.fetchJson('omnidocbench/demo.json', F.ghRaw('opendatalab/OmniDocBench', 'main', 'demo_data/omnidocbench_demo/OmniDocBench_demo.json'))
    const arr = Array.isArray(o.json) ? o.json : (o.json.data || [])
    console.log(`demo.json: ${o.json.length ? '' : ''}条目 ${arr.length}，字段: ${keys(arr[0])}`)
    if (arr[0]) {
      for (const k of Object.keys(arr[0])) {
        const v = arr[0][k]
        console.log(`   ${k}: ${Array.isArray(v) ? `array(${v.length}) ${peek(v[0], 120)}` : peek(v, 120)}`)
      }
    }
  } catch (e) { console.log('  ❌ ' + e.message) }

  // ---------- BFCL ----------
  console.log('\n=== BFCL v4（非实时类，可用本地答案判分）===')
  try {
    const q = await F.fetchJson('bfcl/simple_python.json', F.ghRaw('ShishirPatil/gorilla', 'main', 'berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_simple_python.json'))
    const arr = Array.isArray(q.json) ? q.json : (q.json.data || [])
    console.log(`BFCL_v4_simple_python.json: ${arr.length} 条，字段: ${keys(arr[0])}`)
    console.log(`  样例: ${peek(arr[0], 400)}`)
    const a = await F.fetchJson('bfcl/ans_simple_python.json', F.ghRaw('ShishirPatil/gorilla', 'main', 'berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_simple_python.json'))
    const aarr = Array.isArray(a.json) ? a.json : (a.json.data || [])
    console.log(`possible_answer: ${aarr.length} 条，字段: ${keys(aarr[0])}`)
    console.log(`  样例: ${peek(aarr[0], 400)}`)
  } catch (e) { console.log('  ❌ ' + e.message) }
})()

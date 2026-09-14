/**
 * 预检：在花掉几千次模型调用之前，先把"数据映射对不对"验一遍。
 * 任何一条对不上，都必须在评测开始前暴露，而不是等出数之后才发现样本本身就是错的。
 *
 *   node bench/external/tools/preflight.js
 */
const path = require('node:path')
const fs = require('node:fs')
const F = require('../lib/fetch')
const G = require('../lib/grade')

const TREES = path.join(__dirname, '..', 'cache', 'trees')
const treeOf = (k) => JSON.parse(fs.readFileSync(path.join(TREES, `${k}.json`), 'utf8')).tree
const ok = (b) => (b ? '✅' : '❌')

let failures = 0
const check = (label, cond, extra = '') => {
  if (!cond) failures++
  console.log(`  ${ok(cond)} ${label}${extra ? '  ' + extra : ''}`)
}

;(async () => {
  // ---------- CFLUE ----------
  console.log('=== CFLUE ===')
  const cflue = JSON.parse(F.rawText('cflue/knowledge.json'))
  let parseFail = 0, fewOpts = 0, ansOutOfRange = 0
  const re = /'([A-H])'\s*:\s*'((?:[^'\\]|\\.)*)'/g
  for (const q of cflue) {
    const keys = [...String(q.choices || '').matchAll(re)].map((m) => m[1])
    if (!keys.length) parseFail++
    else if (keys.length < 2) fewOpts++
    const ans = String(q.answer || '').trim()
    if (!ans || [...ans].some((c) => !keys.includes(c))) ansOutOfRange++
  }
  check('选项解析失败 = 0', parseFail === 0, `失败 ${parseFail}`)
  check('选项数 < 2 = 0', fewOpts === 0, `异常 ${fewOpts}`)
  check('答案字母都在选项内', ansOutOfRange === 0, `越界 ${ansOutOfRange}`)
  const app = JSON.parse(F.rawText('cflue/application.json'))
  const appStr = (a) => (typeof a.output === 'string' ? a.output : JSON.stringify(a.output))
  check('应用题都有参考输出', app.every((a) => appStr(a).trim().length > 0), `${app.length} 条`)
  const structured = app.filter((a) => typeof a.output !== 'string')
  console.log(`     参考输出为结构化 JSON 的：${structured.length} 条（${[...new Set(structured.map((a) => a.sub_task))].join('、')}）→ 判分器需支持数组/对象比对`)
  const withHistory = app.filter((a) => Array.isArray(a.history) && a.history.length).length
  const withInput = app.filter((a) => String(a.input || '').trim()).length
  console.log(`     含多轮 history：${withHistory} 条；input 非空：${withInput} 条（均为单轮 instruction 任务）`)

  // ---------- FinEval ----------
  console.log('\n=== FinEval ===')
  const num = F.parseTable(F.rawText('fineval/rigor_numerical.csv'), ',')
  const numOk = num.rows.filter((r) => (r['基座query'] || '').trim() && (r['标准答案'] || '').trim())
  check('数值计算题字段齐全', numOk.length === num.rows.length, `${numOk.length}/${num.rows.length}`)
  console.log(`     标准答案样例: ${num.rows.slice(0, 5).map((r) => JSON.stringify(String(r['标准答案']).slice(0, 40))).join(' | ')}`)
  console.log(`     计算逻辑样例: ${JSON.stringify(String(num.rows[0]['题目答案计算逻辑']).slice(0, 120))}`)

  const idxRows = F.parseDelimited(F.rawText('fineval/rigor_index.csv'), ',')
  const h = idxRows[0]
  const iQuery = h.indexOf('基座大模型query'), iRef = h.indexOf('参考答案'), iType = h.indexOf('类型')
  const idx = idxRows.slice(1).map((r) => ({ q: r[iQuery], ref: r[iRef], type: r[iType] })).filter((r) => r.q && r.ref)
  check('指标抽取题字段齐全', idx.length === idxRows.length - 1, `${idx.length}/${idxRows.length - 1}`)
  const refParse = idx.filter((r) => { try { return Array.isArray(JSON.parse(r.ref)) } catch { return false } })
  check('参考答案都是 JSON 数组', refParse.length === idx.length, `${refParse.length}/${idx.length}`)
  const withNums = refParse.filter((r) => JSON.parse(r.ref).some((s) => G.numbersOf(s).length))
  check('参考答案含可判数字', withNums.length > idx.length * 0.8, `${withNums.length}/${idx.length}`)

  // FinEval-MM 图像路径映射：**必须按仓库真实文件树判定**（这里是踩过坑的地方）
  const S = require('../sources')
  const repoFiles = await S.repoPathSet('fineval')
  let total = 0, withImg = 0, withAns = 0, resolvable = 0, usable = 0
  const missingBySub = {}
  let totalRows = 0
  for (const tsv of S.FINEVAL_MM) {
    const t = F.parseTable(F.rawText(`fineval/mm_${tsv.split('/').pop()}`), '\t')
    for (const r of t.rows) {
      totalRows++
      const img = String(r.image || '').trim()
      const ans = String(r.answer || '').trim()
      if (!img) continue
      withImg++
      if (!ans) continue
      withAns++
      const repoPath = 'multimodeldata/' + img.replace(/^data\//, '')
      if (!repoFiles.has(repoPath)) {
        const sub = img.replace(/^data\/figure\//, '').split('/')[0]
        missingBySub[sub] = (missingBySub[sub] || 0) + 1
        continue
      }
      resolvable++
      const choices = ['A', 'B', 'C', 'D'].map((k) => String(r[k] || '').trim()).filter(Boolean)
      if (choices.length >= 2) usable++
    }
  }
  total = usable
  console.log(`     数据可得性漏斗：行 ${totalRows} → 带图 ${withImg} → 带图有答案 ${withAns} → 图像在仓库中 ${resolvable} → 可用 ${usable}`)
  console.log(`     拿不到图像的目录：${Object.entries(missingBySub).sort((a, b) => b[1] - a[1]).map(([k, v]) => `figure/${k}×${v}`).join('、') || '无'}`)
  check('多模态题存在可用子集', usable > 100, `${usable} 题`)
  check('可用题的图像确实在仓库中', resolvable >= usable, `${resolvable} ≥ ${usable}`)

  // ---------- FinanceBench ----------
  console.log('\n=== FinanceBench ===')
  const fb = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
  const evOk = fb.filter((r) => Array.isArray(r.evidence) && r.evidence.some((e) => (e.evidence_text || '').trim().length > 50))
  check('evidence 可用（≥50 字）', evOk.length === fb.length, `${evOk.length}/${fb.length}`)
  const evLen = fb.map((r) => (r.evidence || []).reduce((s, e) => s + (e.evidence_text || '').length, 0))
  evLen.sort((a, b) => a - b)
  console.log(`     evidence 总长 min/中位/max = ${evLen[0]}/${evLen[Math.floor(evLen.length / 2)]}/${evLen[evLen.length - 1]} 字`)
  const numeric = fb.filter((r) => /^-?\$?\s?[\d,]+(\.\d+)?%?$/.test(String(r.answer).trim()))
  check('存在纯数值答案题', numeric.length >= 40, `${numeric.length} 题`)
  const pub = F.parseJsonl(F.rawText('financebench/results_gpt4_oracle.jsonl')).rows
  const idsMatch = pub.every((p) => fb.some((q) => q.financebench_id === p.financebench_id))
  check('论文结果与题目可按 id 对齐', idsMatch, `${pub.length} 条公开结果`)
  // 我们的确定性判分器 vs 论文标签：先看方向是否合理（一致性应在高位）
  let agree = 0, gradedN = 0
  for (const p of pub) {
    const det = G.numericMatch(String(p.model_answer), String(p.gold_answer))
    if (det === null) continue
    gradedN++
    const mine = det.hit
    if (mine === (p.label === 'Correct Answer')) agree++
  }
  console.log(`     确定性数值判分在 ${gradedN} 条数值题上与论文标签一致 ${agree} 条（${gradedN ? ((agree / gradedN) * 100).toFixed(1) : 'n/a'}%）`)

  // ---------- BFCL ----------
  console.log('\n=== BFCL ===')
  for (const [name, key, ansKey] of [['simple_python', 'bfcl/simple_python.jsonl', 'bfcl/ans_simple_python.jsonl'], ['multiple', 'bfcl/multiple.jsonl', 'bfcl/ans_multiple.jsonl']]) {
    const q = F.parseJsonl(F.rawText(key)).rows
    const a = F.parseJsonl(F.rawText(ansKey)).rows
    const map = new Map(a.map((x) => [x.id, x.ground_truth]))
    const missing = q.filter((x) => !map.has(x.id)).length
    check(`${name}: 每题都有标准答案`, missing === 0, `${q.length} 题 / ${a.length} 答案`)
    const shape = q.filter((x) => !x.function || !x.function.length || !x.function[0].parameters).length
    check(`${name}: 函数描述齐全`, shape === 0, `缺描述 ${shape}`)
    const dotted = q.filter((x) => (x.function || []).some((f) => f.name.includes('.'))).length
    if (dotted) console.log(`     ${dotted} 题的函数名含点号（发给 API 前会规范成下划线，比较时同样规范化）`)
  }
  const irr = F.parseJsonl(F.rawText('bfcl/irrelevance.jsonl')).rows
  check('irrelevance 无标准答案文件（正确行为=不调用）', true, `${irr.length} 题`)

  // ---------- OmniDocBench ----------
  console.log('\n=== OmniDocBench ===')
  const demo = JSON.parse(F.rawText('omnidocbench/demo.json'))
  const missingImg = demo.filter((p) => !fs.existsSync(F.rawPath('omnidocbench_pages/' + p.page_info.image_path)))
  check('18 页图像全部到位', missingImg.length === 0, `缺 ${missingImg.length}`)
  const gtLen = demo.map((p) => (p.layout_dets || []).filter((d) => !d.ignore && d.text).map((d) => d.text).join('\n').length)
  gtLen.sort((a, b) => a - b)
  check('标注文本非空', gtLen[0] > 100, `GT 长度 min/中位/max = ${gtLen[0]}/${gtLen[Math.floor(gtLen.length / 2)]}/${gtLen[gtLen.length - 1]}`)
  const hasTable = demo.filter((p) => (p.layout_dets || []).some((d) => d.category_type === 'table' && d.text)).length
  console.log(`     含表格的页面 ${hasTable}/${demo.length}；含公式的页面 ${demo.filter((p) => (p.layout_dets || []).some((d) => d.category_type.startsWith('equation'))).length}`)

  console.log(`\n预检结果：${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
  process.exit(failures === 0 ? 0 : 1)
})()

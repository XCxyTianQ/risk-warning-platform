/**
 * 一次性把外部基准"拉齐"：抓取固定文件、核查许可证、盘点题量与题型分布。
 *
 * 用法：
 *   node bench/external/prepare.js               # 命中缓存则零网络
 *   node bench/external/prepare.js --refresh     # 强制重新下载（哈希会写进 out/manifest.json）
 *   node bench/external/prepare.js --with-assets # 同时抓 OmniDocBench 18 页页面图与参考 md
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('./lib/fetch')
const S = require('./sources')

const OUT = path.join(__dirname, 'out')
F.ensureDir(OUT)
const TREES = path.join(__dirname, 'cache', 'trees')

const arg = (n) => process.argv.includes(n)
const val = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

function treeOf(key) {
  const f = path.join(TREES, `${key}.json`)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).tree : null
}

/** 许可证核查：不臆测，只报告"仓库里有没有 LICENSE 文件 + 它的名字" */
async function licenseCheck() {
  console.log('\n=== 许可证核查（只报告事实，不做法律结论）===')
  const out = {}
  for (const [b, { repo, ref }] of Object.entries(S.REFS)) {
    const treeKey = { cflue: 'cflue', fineval: 'fineval', financebench: 'financebench', bfcl: 'gorilla', omnidocbench: 'omnidocbench' }[b]
    const tree = treeOf(treeKey) || []
    const lic = tree.find((x) => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(x.path.split('/').pop()))
    if (!lic) {
      out[b] = { licenseFile: null, note: '仓库树中未见 LICENSE/COPYING 文件，以官方仓库说明为准；本仓库仅用于研究性评测，不二次分发原始数据' }
      console.log(`  ${b.padEnd(14)} 未发现 LICENSE 文件（以官方仓库为准）`)
      continue
    }
    try {
      const r = await F.fetchText(`${b}/_license`, F.ghRaw(repo, ref, lic.path))
      const first = r.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || ''
      const guess = /apache/i.test(r.text.slice(0, 400)) ? 'Apache-2.0'
        : /MIT License/i.test(r.text.slice(0, 400)) ? 'MIT'
        : /GNU GENERAL PUBLIC LICENSE/i.test(r.text.slice(0, 800)) ? 'GPL'
        : /Creative Commons/i.test(r.text.slice(0, 800)) ? 'CC'
        : '见文件原文'
      out[b] = { licenseFile: lic.path, firstLine: first.slice(0, 120), guess, sha256: r.sha256 }
      console.log(`  ${b.padEnd(14)} ${lic.path.padEnd(16)} → ${guess}  「${first.slice(0, 60)}」`)
    } catch (e) {
      out[b] = { licenseFile: lic.path, error: e.message }
      console.log(`  ${b.padEnd(14)} ${lic.path} 下载失败: ${e.message}`)
    }
  }
  return out
}

/** 把各基准的"题量、题型、字段"盘清楚——判分器就按这份事实来写 */
async function inventory() {
  console.log('\n=== 题库盘点（判分口径的事实依据）===')
  const inv = {}
  const read = (key) => F.rawText(key)

  // --- CFLUE ---
  const cflue = JSON.parse(read('cflue/knowledge.json'))
  const subj = {}
  const task = {}
  for (const q of cflue) { subj[q['名称']] = (subj[q['名称']] || 0) + 1; task[q.task] = (task[q.task] || 0) + 1 }
  const app = JSON.parse(read('cflue/application.json'))
  const appTask = {}
  for (const a of app) { const k = `${a.task} / ${a.sub_task}`; appTask[k] = (appTask[k] || 0) + 1 }
  inv.cflue = { knowledge: cflue.length, knowledgeByTask: task, knowledgeBySubject: subj, application: app.length, applicationByTask: appTask }
  console.log(`  CFLUE 知识题 ${cflue.length}（题型 ${JSON.stringify(task)}）`)
  console.log(`    科目分布: ${Object.entries(subj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ')}`)
  console.log(`  CFLUE 应用题 ${app.length}，子任务分布:`)
  for (const [k, v] of Object.entries(appTask).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}  ${k}`)

  // --- FinEval ---
  const num = F.parseTable(read('fineval/rigor_numerical.csv'), ',')
  const idxText = read('fineval/rigor_index.csv')
  const idxRows = F.parseDelimited(idxText, ',')
  const idxHeader = idxRows[0]
  const idxTypes = {}
  for (const r of idxRows.slice(1)) { const t = r[idxHeader.indexOf('类型')]; if (t) idxTypes[t] = (idxTypes[t] || 0) + 1 }
  inv.fineval = {
    rigorNumerical: { rows: num.rows.length, header: num.header },
    rigorIndex: { rows: idxRows.length - 1, header: idxHeader, byType: idxTypes },
  }
  console.log(`  FinEval 严谨性-数值计算 ${num.rows.length} 行，字段 ${num.header.join('/')}`)
  console.log(`  FinEval 严谨性-指标抽取 ${idxRows.length - 1} 行，类型分布 ${JSON.stringify(idxTypes)}`)
  const idxAns = idxRows.slice(1, 4).map((r) => r[idxHeader.indexOf('参考答案')])
  console.log(`     参考答案样例: ${idxAns.map((a) => JSON.stringify(String(a).slice(0, 60))).join(' | ')}`)

  // --- FinanceBench ---
  const fb = F.parseJsonl(read('financebench/open_source.jsonl')).rows
  const evType = typeof fb[0].evidence
  const evSamples = fb.slice(0, 2).map((r) => JSON.stringify(r.evidence).slice(0, 220))
  const qt = {}
  for (const r of fb) qt[r.question_type] = (qt[r.question_type] || 0) + 1
  const numeric = fb.filter((r) => /^-?\$?\s?[\d,]+(\.\d+)?%?$/.test(String(r.answer).trim())).length
  const published = F.parseJsonl(read('financebench/results_gpt4_oracle.jsonl')).rows
  const labels = {}
  for (const r of published) labels[r.label] = (labels[r.label] || 0) + 1
  inv.financebench = { questions: fb.length, byType: qt, numericAnswers: numeric, evidenceType: evType, publishedOracleRows: published.length, publishedLabels: labels }
  console.log(`  FinanceBench ${fb.length} 题，题型 ${JSON.stringify(qt)}，纯数值答案 ${numeric} 题`)
  console.log(`     evidence 字段类型: ${evType}；样例: ${evSamples[0]}`)
  console.log(`     论文 GPT-4 oracle 结果 ${published.length} 条，标签分布 ${JSON.stringify(labels)}`)

  // --- BFCL ---
  const bfcl = {}
  for (const [k, f] of [['simple_python', 'bfcl/simple_python.jsonl'], ['multiple', 'bfcl/multiple.jsonl'], ['irrelevance', 'bfcl/irrelevance.jsonl']]) {
    const rows = F.parseJsonl(read(f)).rows
    bfcl[k] = { rows: rows.length }
    console.log(`  BFCL ${k}: ${rows.length} 题（多函数题占比 ${(rows.filter((r) => (r.function || []).length > 1).length / rows.length * 100).toFixed(0)}%）`)
  }
  const ansMul = F.parseJsonl(read('bfcl/ans_multiple.jsonl')).rows
  console.log(`     multiple 标准答案 ${ansMul.length} 条；样例 ${JSON.stringify(ansMul[0]).slice(0, 200)}`)
  inv.bfcl = bfcl

  // --- OmniDocBench ---
  const demo = JSON.parse(read('omnidocbench/demo.json'))
  const ds = {}
  for (const p of demo) {
    const a = (p.page_info && p.page_info.page_attribute) || {}
    const k = `${a.data_source || '?'}/${a.language || '?'}/${a.layout || '?'}`
    ds[k] = (ds[k] || 0) + 1
  }
  const catCount = {}
  for (const p of demo) for (const d of p.layout_dets || []) catCount[d.category_type] = (catCount[d.category_type] || 0) + 1
  inv.omnidocbench = { pages: demo.length, byAttr: ds, byCategoryType: catCount }
  console.log(`  OmniDocBench demo ${demo.length} 页`)
  console.log(`     页面属性分布: ${Object.entries(ds).map(([k, v]) => `${k}:${v}`).join(', ')}`)
  console.log(`     版面元素分布: ${JSON.stringify(catCount)}`)

  return inv
}

;(async () => {
  const refresh = arg('--refresh')
  console.log('=== 抓取固定文件 ===')
  const manifest = await S.ensureFixed({ refresh })
  const licenses = await licenseCheck()
  const inv2 = await inventory()

  if (arg('--with-assets')) {
    console.log('\n=== 抓取 OmniDocBench 页面图与参考 md ===')
    const demo = JSON.parse(F.rawText('omnidocbench/demo.json'))
    const tree = treeOf('omnidocbench') || []
    const base = 'demo_data/omnidocbench_demo/'
    const imgs = tree.filter((x) => x.path.startsWith(base + 'images/'))
    const mds = tree.filter((x) => x.path.startsWith(base + 'mds/') && x.path.endsWith('.md'))
    for (const x of imgs) await S.repoFile('omnidocbench', x.path, `omnidocbench_pages/${x.path.split('/').pop()}`, { force: refresh })
    for (const x of mds) await S.repoFile('omnidocbench', x.path, `omnidocbench_mds/${x.path.split('/').pop()}`, { force: refresh })
    console.log(` 页面图 ${imgs.length} 张、参考 md ${mds.length} 份已缓存（demo 页数 ${demo.length}）`)
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    note: '外部基准对齐的输入清单：来源、版本、字节数、sha256。原始数据不入库，本文件入库以保证"跑的是哪一版"可复查。',
    refs: S.REFS,
    benchmarks: S.BENCHMARKS,
    files: manifest,
    licenses,
    inventory: inv2,
  }
  const file = path.join(OUT, 'manifest.json')
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  const totalMB = manifest.reduce((s, m) => s + m.bytes, 0) / 1048576
  console.log(`\n清单已写入 bench/external/out/manifest.json（${manifest.length} 个文件，${totalMB.toFixed(2)} MB）`)
  console.log(`缓存目录: bench/external/cache/raw（不入库）`)
})()

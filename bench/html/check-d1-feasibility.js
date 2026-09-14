/**
 * D1 可行性核查：
 *  1. 平台后端是否支持 PDF（已知：只收图片）→ 决定 D1 是"走产品链路"还是"评测侧原型"
 *  2. 150 道题涉及多少份文档、总体积多大（决定下载与处理成本）
 *  3. 本机有哪些可用的 PDF 文本抽取路径（node 库 / python 库 / 命令行）
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const REPO = path.resolve(__dirname, '..', '..')

// 1) 需要的文档与体积
const tree = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'cache', 'trees', 'financebench.json'), 'utf8')).tree
const pdfSize = new Map(tree.filter((x) => x.path.startsWith('pdfs/')).map((x) => [x.path.replace('pdfs/', ''), x.size || 0]))
const qs = fs.readFileSync(path.join(REPO, 'bench', 'external', 'cache', 'raw', 'financebench_open_source.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
const docs = [...new Set(qs.map((q) => q.doc_name))]
let total = 0, missing = 0
const sizes = []
for (const d of docs) {
  const s = pdfSize.get(d + '.pdf')
  if (s === undefined) { missing++; continue }
  total += s
  sizes.push([d, s])
}
sizes.sort((a, b) => b[1] - a[1])
console.log(`=== 文档需求 ===`)
console.log(`  题目 ${qs.length} 道，涉及文档 ${docs.length} 份；仓库中有 PDF 的 ${sizes.length} 份（缺 ${missing}）`)
console.log(`  总体积 ${(total / 1048576).toFixed(1)} MB；最大 5 份：${sizes.slice(0, 5).map(([d, s]) => `${d}(${(s / 1048576).toFixed(1)}MB)`).join(', ')}`)
console.log(`  中位体积 ${(sizes[Math.floor(sizes.length / 2)][1] / 1048576).toFixed(2)} MB`)

// 2) 抽取路径
console.log('\n=== 可用的 PDF 抽取路径 ===')
const nodeLibs = ['pdf-parse', 'pdfjs-dist', 'pdf2json']
for (const lib of nodeLibs) {
  const p = path.join(REPO, 'node_modules', lib)
  const p2 = path.join(REPO, 'desktop', 'node_modules', lib)
  console.log(`  node:${lib} → ${fs.existsSync(p) || fs.existsSync(p2) ? '已安装' : '未安装'}`)
}
const py = path.join(REPO, 'server', '.venv', 'Scripts', 'python.exe')
const pyBin = fs.existsSync(py) ? py : 'python'
for (const mod of ['pypdf', 'PyPDF2', 'pdfplumber', 'fitz']) {
  const r = spawnSync(pyBin, ['-c', `import ${mod}; print(getattr(${mod}, '__version__', 'ok'))`], { encoding: 'utf8' })
  console.log(`  python:${mod} → ${r.status === 0 ? '可用 (' + (r.stdout || '').trim() + ')' : '不可用'}`)
}
console.log(`  python 解释器：${pyBin}`)

// 3) 平台侧
console.log('\n=== 平台侧结论 ===')
const att = fs.readFileSync(path.join(REPO, 'backend', 'src', 'services', 'attachments.rs'), 'utf8')
const m = att.match(/ALLOWED_MIME[^;]*;/s)
console.log('  后端允许的附件类型：' + (m ? m[0].replace(/\s+/g, ' ').slice(0, 120) : '?'))
const cargo = fs.readFileSync(path.join(REPO, 'backend', 'Cargo.toml'), 'utf8')
console.log(`  后端依赖中是否有 PDF 库：${/pdf/i.test(cargo) ? '有' : '没有'}`)

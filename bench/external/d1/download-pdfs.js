/**
 * 按需下载 FinanceBench 的 10-K PDF（只下题目用到的那些，可断点续传）。
 *   node bench/external/d1/download-pdfs.js            # 只下 dev 切分用到的文档
 *   node bench/external/d1/download-pdfs.js --all      # 全部 84 份（157.9 MB）
 *   node bench/external/d1/download-pdfs.js --docs 3M_2018_10K,ADOBE_2018_10K
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')

const EXT = path.join(__dirname, '..')
const PDF_DIR = path.join(EXT, 'cache', 'raw', 'financebench_pdfs')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes(n)

;(async () => {
  const questions = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
  const allDocs = [...new Set(questions.map((q) => q.doc_name))].sort()
  let docs = allDocs
  if (!has('--all')) {
    const splitFile = path.join(EXT, 'out', 'financebench-split.json')
    if (has('--docs')) {
      docs = arg('--docs').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (fs.existsSync(splitFile)) {
      const split = JSON.parse(fs.readFileSync(splitFile, 'utf8'))
      const devIds = new Set(split.dev)
      docs = [...new Set(questions.filter((q) => devIds.has(q.financebench_id)).map((q) => q.doc_name))].sort()
      console.log(`按 dev 切分（${split.dev.length} 题）下载 ${docs.length} 份文档`)
    }
  }
  fs.mkdirSync(PDF_DIR, { recursive: true })
  const tree = JSON.parse(fs.readFileSync(path.join(EXT, 'cache', 'trees', 'financebench.json'), 'utf8')).tree
  const sizeOf = new Map(tree.filter((x) => x.path.startsWith('pdfs/')).map((x) => [x.path.replace('pdfs/', ''), x.size || 0]))

  let got = 0, skipped = 0, bytes = 0, failed = 0
  for (const [i, doc] of docs.entries()) {
    const file = path.join(PDF_DIR, `${doc}.pdf`)
    if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
      skipped++
      bytes += fs.statSync(file).size
      continue
    }
    try {
      const t0 = Date.now()
      const res = await fetch(F.ghRaw('patronus-ai/financebench', 'main', `pdfs/${doc}.pdf`), { headers: F.UA })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(file, buf)
      got++
      bytes += buf.length
      process.stdout.write(`\r  [${i + 1}/${docs.length}] ${doc} ${(buf.length / 1048576).toFixed(1)}MB ${((Date.now() - t0) / 1000).toFixed(1)}s      `)
    } catch (e) {
      failed++
      process.stdout.write(`\r  ❌ ${doc}: ${String(e.message).slice(0, 60)}\n`)
    }
  }
  process.stdout.write('\n')
  console.log(`下载完成：新下 ${got} 份，已存在 ${skipped} 份，失败 ${failed} 份；本地合计 ${(bytes / 1048576).toFixed(1)} MB`)
  const missing = docs.filter((d) => !fs.existsSync(path.join(PDF_DIR, `${d}.pdf`)))
  if (missing.length) console.log(`缺失：${missing.join(', ')}`)
  void sizeOf
})().catch((e) => { console.error(e); process.exit(1) })

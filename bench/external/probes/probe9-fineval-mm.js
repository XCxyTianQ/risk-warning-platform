/**
 * 第九轮探测：FinEval-MM 的图像到底在哪 —— 决定了这个基准能不能做。
 *
 * 已知事实：TSV 里写的是 data/figure/fs/xxx.jpg，而 GitHub 仓库里只有 multimodeldata/figure/cc 等少数目录。
 * 需要查清：
 *  1. TSV 引用了哪些子目录、共多少张图；仓库里实际有哪些子目录；
 *  2. 覆盖多少题；
 *  3. 缺的图能否从 HuggingFace 镜像（hf-mirror.com）拿到（官方域名不可达，镜像可达）。
 */
const path = require('node:path')
const F = require('../lib/fetch')
const S = require('../sources')

;(async () => {
  // 1. TSV 引用的图像前缀
  const referenced = new Map()
  const rows = []
  for (const tsv of S.FINEVAL_MM) {
    const t = F.parseTable(F.rawText(`fineval/mm_${tsv.split('/').pop()}`), '\t')
    for (const r of t.rows) {
      const img = String(r.image || '').trim()
      if (!img) continue
      const sub = img.replace(/^data\/figure\//, '').split('/')[0]
      referenced.set(sub, (referenced.get(sub) || 0) + 1)
      rows.push({ img, answer: String(r.answer || '').trim(), fintype: r.fintype })
    }
  }
  console.log('TSV 引用的图像子目录:')
  for (const [k, v] of [...referenced.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)} 张  figure/${k}/`)

  // 2. 仓库实际有哪些子目录
  const tree = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'cache', 'trees', 'fineval.json'), 'utf8')).tree
  const repoFiles = new Set(tree.map((x) => x.path))
  const repoSudirs = new Map()
  for (const x of tree) {
    const m = x.path.match(/^multimodeldata\/figure\/([^/]+)\//)
    if (m) repoSudirs.set(m[1], (repoSudirs.get(m[1]) || 0) + 1)
  }
  console.log('\n仓库 multimodeldata/figure 实际子目录:')
  for (const [k, v] of [...repoSudirs.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)} 个  figure/${k}/`)

  // 3. 覆盖率
  let hit = 0
  const hitByType = {}
  for (const r of rows) {
    const cand = 'multimodeldata/' + r.img.replace(/^data\//, '')
    if (repoFiles.has(cand)) {
      hit++
      hitByType[r.fintype] = (hitByType[r.fintype] || 0) + 1
    }
  }
  console.log(`\n仓库内可解析的图像: ${hit}/${rows.length} 题（${((hit / rows.length) * 100).toFixed(1)}%）`)
  console.log(`可解析题型: ${JSON.stringify(hitByType)}`)

  // 4. HF 镜像上有没有这些图
  console.log('\n=== HuggingFace 镜像探测（hf-mirror.com）===')
  const candidates = ['SUFE-AIFLM-Lab/FinEval', 'SUFE-AIFLM-Lab/FinEval-MM', 'TheFinAI/FinEval']
  for (const id of candidates) {
    for (const kind of ['datasets', 'models']) {
      const url = `https://hf-mirror.com/api/${kind}/${id}`
      try {
        const res = await fetch(url, { headers: F.UA })
        const text = await res.text()
        if (!res.ok) { console.log(`   ${kind}/${id}: HTTP ${res.status}`); continue }
        const j = JSON.parse(text)
        const sib = (j.siblings || []).map((s) => s.rfilename)
        const figs = sib.filter((f) => /figure|\.jpg|\.png/i.test(f))
        console.log(`   ✅ ${kind}/${id}: ${sib.length} 个文件，其中图像类 ${figs.length}`)
        figs.slice(0, 6).forEach((f) => console.log(`        ${f}`))
      } catch (e) {
        console.log(`   ❌ ${kind}/${id}: ${String(e.message).slice(0, 80)}`)
      }
    }
  }
})()

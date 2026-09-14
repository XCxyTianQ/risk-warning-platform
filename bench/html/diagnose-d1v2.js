/**
 * D1 v2 诊断（零成本）：检索命中但答错的题，到底错在哪一类。
 * 分类：① 取错行项目（答案里的数字完全不在预测里）② 数字对但表述/单位不同 ③ 拒答/答非所问
 */
const fs = require('node:fs')
const path = require('node:path')
const EXT = path.join(__dirname, '..', 'external')
const EXP = path.join(EXT, 'out', 'experiments')

const f = fs.readdirSync(EXP).filter((x) => /^d1-dev-.*\.json$/.test(x)).sort().pop()
const j = JSON.parse(fs.readFileSync(path.join(EXP, f), 'utf8'))
const ok = j.rows.filter((r) => !r.error)
console.log(`文件 ${f}；n=${ok.length}；准确率 ${j.accuracyPct}%；检索命中 ${j.retrievalHitPct}%\n`)

const nums = (t) => (String(t).match(/-?\d+(?:[.,]\d+)?%?/g) || []).map((x) => x.replace(/,/g, ''))
const goldNum = (g) => { const s = String(g).replace(/[^\d.\-]/g, ''); const v = Number(s); return Number.isFinite(v) ? v : null }

const buckets = { wrong_line_item: [], unit_or_scale: [], refusal: [], text_wrong: [], judge_strict: [] }
for (const r of ok) {
  if (r.judge === 'CORRECT') continue
  const pred = String(r.prediction || '')
  if (r.judge === 'REFUSAL' || /cannot determine|not provide|unable to/i.test(pred)) { buckets.refusal.push(r); continue }
  const g = goldNum(r.gold)
  const cands = nums(pred).map(Number).filter(Number.isFinite)
  if (g === null) { buckets.text_wrong.push(r); continue }
  const near = cands.some((c) => (g === 0 ? Math.abs(c) < 1e-9 : Math.abs(c - g) / Math.abs(g) <= 0.02))
  const scaled = cands.some((c) => {
    if (!c || !g) return false
    for (const k of [1e-3, 1e-6, 1e3, 1e6]) if (Math.abs(c - g * k) / Math.abs(g * k) <= 0.02) return true
    return false
  })
  if (near) buckets.judge_strict.push(r)
  else if (scaled) buckets.unit_or_scale.push(r)
  else buckets.wrong_line_item.push(r)
}

console.log('=== 答错题（检索已命中）的错因分布 ===')
for (const [k, v] of Object.entries(buckets)) {
  const label = { wrong_line_item: '取错行项目（数字完全不在预测里）', unit_or_scale: '单位/量纲差 10 的幂', refusal: '拒答或答非所问', text_wrong: '文本题答错', judge_strict: '数字其实对了（2% 内）但被判错' }[k]
  console.log(`  ${String(v.length).padStart(2)}  ${label}`)
}

console.log('\n=== 逐题（检索命中但答错）===')
for (const [k, list] of Object.entries(buckets)) {
  for (const r of list.slice(0, 4)) {
    console.log(`\n[${k}] ${r.id} (${r.type}) 命中=${r.retrieval.hit} 覆盖率=${r.retrieval.coverage}`)
    console.log(`  gold=${JSON.stringify(String(r.gold).slice(0, 70))}`)
    console.log(`  pred=${JSON.stringify(String(r.prediction).slice(0, 170))}`)
  }
}

// 检索命中率 vs 答题正确率的联合分布，用于判断该继续提召回还是提精度
const both = ok.filter((r) => r.retrieval.hit && r.judge === 'CORRECT').length
const hitWrong = ok.filter((r) => r.retrieval.hit && r.judge !== 'CORRECT').length
const missRight = ok.filter((r) => !r.retrieval.hit && r.judge === 'CORRECT').length
const missWrong = ok.filter((r) => !r.retrieval.hit && r.judge !== 'CORRECT').length
console.log(`\n=== 联合分布 ===`)
console.log(`  检索命中 & 答对：${both}`)
console.log(`  检索命中 & 答错：${hitWrong}  ← 精度问题（上下文里有答案却没答对）`)
console.log(`  检索未命中 & 答对：${missRight}  ← 模型自己猜对/凭知识答对`)
console.log(`  检索未命中 & 答错：${missWrong}  ← 召回问题`)
console.log(`\n结论：若"命中但答错"多于"未命中且答错"，下一阶段应提精度（重排/裁剪上下文）而非提召回。`)

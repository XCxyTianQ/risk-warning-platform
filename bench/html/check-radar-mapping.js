/** 校验雷达图的"轴—数值"对应关系：每个维度标签附近的数值必须来自该维度 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const html = fs.readFileSync(path.join(REPO, 'docs', 'reports', 'Benchmark-Platform-Report-v1.html'), 'utf8')
const js = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'out', 'radar-data.json'), 'utf8'))

const blocks = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0])
const svg = blocks.find((b) => b.includes('rd-label'))
if (!svg) {
  console.error('❌ 页面里找不到雷达图（没有 rd-label）')
  process.exit(1)
}
const grab = (cls) => [...svg.matchAll(new RegExp(`<text x="([\\d.\\-]+)" y="([\\d.\\-]+)" class="${cls}"[^>]*>([^<]+)</text>`, 'g'))]
  .map((m) => ({ x: +m[1], y: +m[2], text: m[3] }))
const labels = grab('rd-label')
const vals = grab('rd-val')
const axes = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" class="rd-axis"\/>/g)]
  .map((m) => ({ x2: +m[3], y2: +m[4] }))
if (!labels.length || !vals.length || !axes.length) {
  console.error(`❌ 解析不完整：标签 ${labels.length}、数值 ${vals.length}、轴 ${axes.length}`)
  process.exit(1)
}

console.log('轴端点：', axes.map((a) => `(${a.x2.toFixed(0)},${a.y2.toFixed(0)})`).join(' '))
console.log('维度标签：', labels.map((l) => `${l.text}(${l.x.toFixed(0)},${l.y.toFixed(0)})`).join(' '))
console.log('本平台数值：', vals.map((v) => `${v.text}(${v.x.toFixed(0)},${v.y.toFixed(0)})`).join(' '))

// 把每个数值配到最近的维度标签（按几何位置：数值点与顶点在同一条轴上，标签离顶点最近）
const TYPES = js.types
const expect = TYPES.map((t) => js.ours.byType[t].accuracyPct)
console.log('\n期望（指标类 / 领域推理 / 新颖生成）：', expect.join(' / '))

// 顶点方向：从中心(0轴向上)推断——用标签与轴的相对位置判断归属
let ok = true
axes.forEach((a, i) => {
  // 与顶点最近的那个数值点
  let best = null
  for (const v of vals) {
    const d = Math.hypot(v.x - a.x2, v.y - a.y2)
    if (!best || d < best.d) best = { d, v }
  }
  const label = labels.reduce((acc, l) => {
    const d = Math.hypot(l.x - a.x2, l.y - a.y2)
    return !acc || d < acc.d ? { d, l } : acc
  }, null)
  const idx = TYPES.findIndex((t) => label.l.text.startsWith({ 'metrics-generated': '指标类', 'domain-relevant': '领域推理', 'novel-generated': '新颖生成' }[t]))
  const got = Number(best.v.text)
  const want = expect[idx]
  const pass = got === want
  if (!pass) ok = false
  console.log(`  ${label.l.text} 顶点=(${a.x2.toFixed(0)},${a.y2.toFixed(0)}) → 图上数值 ${got}，期望 ${want} ${pass ? '✅' : '❌'}`)
})
console.log(ok ? '\n雷达轴—数值对应正确' : '\n雷达轴—数值对应有误')
process.exit(ok ? 0 : 1)

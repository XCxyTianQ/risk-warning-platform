/**
 * 展示页自检（应用式交互页）。
 *
 * 注意：查 undefined/NaN 前必须**剔除 <script> 块**——JS 里 `v === undefined` 是正常写法，
 * 早期版本把源码当渲染内容查，造成假阳性。
 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'docs', 'showcase', 'index.html')
const raw = fs.readFileSync(FILE, 'utf8')
const html = raw.replace(/<script[\s\S]*?<\/script>/gi, '') // 只看渲染内容
const script = (raw.match(/<script[\s\S]*?<\/script>/gi) || []).join('\n')

const loading = []
for (const m of raw.matchAll(/(?:src|srcset|data-src)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) loading.push(m[1])
for (const m of raw.matchAll(/<link[^>]*href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) loading.push(m[1])
for (const m of raw.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"'\s)]+)/gi)) loading.push(m[1])
for (const m of raw.matchAll(/url\(\s*["']?(https?:\/\/[^"'\s)]+)/gi)) loading.push(m[1])

const fc = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'out', 'frontier-challenge.json'), 'utf8'))
const ours = fc.models.find((m) => m.tier === 'ours')
const fable = fc.models.find((m) => m.id === 'claude-fable-5-1')

const checks = [
  ['外部资源引用（会加载的）', loading.length, 0],
  ['<img> 标签', (html.match(/<img/gi) || []).length, 0],
  ['渲染内容里的 undefined/NaN', (html.match(/undefined|NaN/g) || []).length, 0],
  ['重复百分号', (html.match(/%%/g) || []).length, 0],
  // 结构：应用式壳体（左栏切换 + 五个视图）
  ['视图数', (raw.match(/class="view/g) || []).length, 5],
  ['左栏导航项', (raw.match(/data-v="/g) || []).length, 5],
  // 交互：雷达、尺度切换、范围切换、模型开关
  ['雷达容器', raw.includes('id="radar"') ? 1 : 0, 1],
  ['雷达六轴', (raw.match(/财报问答|文档增量|工具调用|拒调判断|图表取数|整页转写/g) || []).length >= 6 ? 1 : 0, 1],
  ['尺度切换按钮', (raw.match(/data-s="/g) || []).length, 2],
  ['范围切换按钮', (raw.match(/data-set="/g) || []).length, 2],
  ['模型开关芯片', (raw.match(/id="chips"/g) || []).length, 1],
  ['悬停读数（轴命中区）', raw.includes("class: 'hit'") ? 1 : 0, 1],
  // 数据一致：展示页的数字必须来自产物
  ['我们文档增量入图', script.includes(String(ours.documentIncrementPp)) ? 1 : 0, 1],
  ['Fable 文档增量入图', script.includes(String(fable.documentIncrementPp)) ? 1 : 0, 1],
  ['闭卷底分入文', raw.includes(fable.closedBookPct.toFixed(2)) ? 1 : 0, 1],
  ['边界视图存在', raw.includes('闭卷是上界') ? 1 : 0, 1],
]
let bad = 0
for (const [name, got, want] of checks) {
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${got}（期望 ${want}）`)
}
console.log(`\n文件 ${(Buffer.byteLength(raw) / 1024).toFixed(0)} KB；内联脚本 ${(Buffer.byteLength(script) / 1024).toFixed(1)} KB；SVG 由脚本生成`)
console.log(bad ? `\n有 ${bad} 项未通过` : '\n展示页自检通过')
process.exit(bad ? 1 : 0)

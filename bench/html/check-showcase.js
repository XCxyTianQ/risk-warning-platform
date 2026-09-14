/** 展示页自检：零外链、无 NaN/undefined、关键数字与产物一致。 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'docs', 'showcase', 'index.html')
const h = fs.readFileSync(FILE, 'utf8')

const loading = []
for (const m of h.matchAll(/(?:src|srcset|data-src)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) loading.push(m[1])
for (const m of h.matchAll(/<link[^>]*href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) loading.push(m[1])
for (const m of h.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"'\s)]+)/gi)) loading.push(m[1])
for (const m of h.matchAll(/url\(\s*["']?(https?:\/\/[^"'\s)]+)/gi)) loading.push(m[1])

const fc = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'out', 'frontier-challenge.json'), 'utf8'))
const ours = fc.models.find((m) => m.tier === 'ours')
const checks = [
  ['外部资源引用', loading.length, 0],
  ['<img> 标签', (h.match(/<img/gi) || []).length, 0],
  ['<script src>', (h.match(/<script[^>]*src=/gi) || []).length, 0],
  ['undefined / NaN', (h.match(/undefined|NaN/g) || []).length, 0],
  ['重复百分号', (h.match(/%%/g) || []).length, 0],
  ['标题存在', h.includes('我们是真的在读文档') ? 1 : 0, 1],
  ['超限表五家齐全', fc.models.every((m) => h.includes(m.label.replace(/（.*?）/g, ''))) ? 1 : 0, 1],
  ['文档增量入图', h.includes('文档增量 +' + ours.documentIncrementPp.toFixed(2) + 'pp') ? 1 : 0, 1],
  ['闭卷对照入文', h.includes(ours.closedBookPct.toFixed(2)) ? 1 : 0, 1],
  ['边界章节存在', h.includes('这份展示没有覆盖到什么') ? 1 : 0, 1],
]
let bad = 0
for (const [name, got, want] of checks) {
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${got}（期望 ${want}）`)
}
console.log(`\n文件 ${(Buffer.byteLength(h) / 1024).toFixed(0)} KB；章节 ${(h.match(/<section/g) || []).length} 个；内联 SVG ${(h.match(/<svg/g) || []).length} 个`)
console.log(bad ? `\n有 ${bad} 项未通过` : '\n展示页自检通过')
process.exit(bad ? 1 : 0)

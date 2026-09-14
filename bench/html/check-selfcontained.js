/**
 * 自检：HTML 报告必须是"单文件零依赖"——不加载任何外部资源。
 *
 * 口径说明：判定的是"会不会去外部取东西"，因此 <a href> 这类**纯导航链接**不算依赖
 * （点开才访问，离线渲染不受影响）；但如果 URL 出现在 img/script/link/@import/iframe/srcset
 * 等会**自动加载**的位置，就必须为 0。
 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'docs', 'reports', 'Benchmark-Platform-Report-v1.html')
const h = fs.readFileSync(FILE, 'utf8')

const externalRefs = () => {
  // 会被自动加载的位置：src= / href=（link、iframe）/ srcset= / url(...) / @import
  const loading = []
  for (const m of h.matchAll(/(?:src|srcset|data-src)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) loading.push(m[1])
  for (const m of h.matchAll(/<link[^>]*href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) loading.push(m[1])
  for (const m of h.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"'\s)]+)/gi)) loading.push(m[1])
  for (const m of h.matchAll(/url\(\s*["']?(https?:\/\/[^"'\s)]+)/gi)) loading.push(m[1])
  const anchors = (h.match(/<a\s[^>]*href\s*=\s*["']https?:\/\//gi) || []).length
  return { loading, anchors, all: (h.match(/https?:\/\//g) || []).length }
}
const refs = externalRefs()

const checks = [
  ['外部资源引用（src/link/@import/url()）', refs.loading.length, 0],
  ['<img> 标签', (h.match(/<img/gi) || []).length, 0],
  ['<script src>', (h.match(/<script[^>]*src=/gi) || []).length, 0],
  ['<link> 标签', (h.match(/<link/gi) || []).length, 0],
  ['@import', (h.match(/@import/gi) || []).length, 0],
  ['undefined', (h.match(/undefined/g) || []).length, 0],
  ['NaN', (h.match(/NaN/g) || []).length, 0],
]
let bad = 0
for (const [name, got, want] of checks) {
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${got}（期望 ${want}）`)
}
const svg = (h.match(/<svg/g) || []).length
const tables = (h.match(/<table/g) || []).length
console.log(`\n内联 SVG 图表 ${svg} 个；表格 ${tables} 张；文件 ${(Buffer.byteLength(h) / 1024).toFixed(0)} KB；${h.split('\n').length} 行`)
console.log(bad === 0 ? '\n单文件零依赖自检通过' : `\n有 ${bad} 项未通过`)
process.exit(bad === 0 ? 0 : 1)

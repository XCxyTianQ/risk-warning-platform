/** 从 OpenClaw 原始输出中抽出最终回答（绕开 JSON 结构差异，按 markdown 特征定位）。 */
const fs = require('node:fs')
const path = require('node:path')
const OUT = path.join(__dirname, '..', 'out')
const t = fs.readFileSync(path.join(OUT, 'task-openclaw-raw2.txt'), 'utf8')

let best = ''
// 策略 1：找所有 JSON 字符串字段里最长的一个
for (const m of t.matchAll(/"((?:[^"\\]|\\.){300,})"/g)) {
  try {
    const s = JSON.parse('"' + m[1] + '"')
    if (s.length > best.length && /[\u4e00-\u9fff]/.test(s)) best = s
  } catch {}
}
// 策略 2：直接按 markdown 特征切
if (!best || best.length < 500) {
  const i = t.indexOf('调研完成')
  if (i >= 0) {
    const tail = t.slice(i)
    const end = tail.search(/\n\s*[}\]"']\s*$|\n\[agents\//)
    best = end > 0 ? tail.slice(0, end) : tail
  }
}
fs.writeFileSync(path.join(OUT, 'task-openclaw-latest.txt'), best)
console.log('抽出回答长度:', best.length, '字')
console.log('--- 章节结构 ---')
for (const h of best.match(/^#{1,4} .+$/gm) || []) console.log('  ' + h)
console.log('--- 末尾 800 字 ---')
console.log(best.slice(-800))

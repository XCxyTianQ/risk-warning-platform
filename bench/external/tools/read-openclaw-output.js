/** 读取 OpenClaw 的原始输出（自动识别 UTF-16/UTF-8），打印末尾若干行以判断成败。 */
const fs = require('node:fs')
const path = require('node:path')
const p = path.join(__dirname, '..', 'out', 'task-openclaw-raw.json')
const buf = fs.readFileSync(p)
const t = (buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString('utf16le') : buf.toString('utf8')).replace(/\r/g, '')
const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
console.log('总行数:', lines.length)
console.log('--- 最后 14 行 ---')
console.log(lines.slice(-14).join('\n').slice(0, 1500))
const jsonStart = t.indexOf('{"')
console.log('\n是否含 JSON 结果:', jsonStart >= 0)
if (jsonStart >= 0) {
  try {
    const j = JSON.parse(t.slice(jsonStart))
    console.log('JSON 顶层键:', Object.keys(j).join(', '))
    for (const k of ['text', 'reply', 'message', 'result', 'content', 'output']) {
      if (j[k]) { console.log(`\n--- ${k}（截取）---`); console.log(String(j[k]).slice(0, 900)) }
    }
  } catch (e) { console.log('JSON 解析失败:', e.message) }
}

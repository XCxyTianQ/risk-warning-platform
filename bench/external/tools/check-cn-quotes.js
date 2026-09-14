/**
 * 一次性检查：列出报告生成器里"ASCII 双引号紧邻中文"的行（这类地方应该是中文引号，否则会破坏 Python 字符串）。
 *   node bench/external/tools/check-cn-quotes.js
 * 只报告，不修改——避免再出现"自动修复把 docstring 改坏"的问题。
 */
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(__dirname, '..', 'report', 'make-alignment-report.py')
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
const lines = fs.readFileSync(file, 'utf8').split('\n')
let n = 0
lines.forEach((line, i) => {
  for (let k = 0; k < line.length; k++) {
    if (line[k] !== '"') continue
    const prev = line[k - 1] || ''
    const next = line[k + 1] || ''
    if (CJK.test(prev) || CJK.test(next)) {
      n++
      console.log(`${i + 1}: ${line.trim().slice(0, 140)}`)
      break
    }
  }
})
console.log(`\n共 ${n} 行需要改成中文引号（「」）`)

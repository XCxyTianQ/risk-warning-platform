/** 追查唯一一条未通过"数字不丢"约束的证据（id 02024） */
const F = require('../external/lib/fetch')
const R = require('../external/lib/restructure')

const rows = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows
const r = rows.find((x) => x.financebench_id === 'financebench_id_02024')
const text = (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n')
const res = R.restructure(text)
console.log('期间识别：', JSON.stringify(res.stats.periods), res.stats.periodSource, 'k=', res.stats.periodCount)
console.log('输入数字数：', res.stats.numbersBefore, ' 输出数字数：', res.stats.numbersAfter)
console.log('丢失：', JSON.stringify(res.stats.numbersMissing), ' 编造：', JSON.stringify(res.stats.numbersInvented))

const nums = (t) => (String(t).match(/-?\d[\d,]*(\.\d+)?/g) || []).map((x) => x.replace(/,/g, ''))
const beforeNums = nums(text)
const afterNums = new Set(nums(res.markdown))
const missingVals = [...new Set(beforeNums)].filter((x) => !afterNums.has(x))
console.log('\n输入里存在、输出里完全没出现的值：', JSON.stringify(missingVals))
for (const v of missingVals) {
  const idx = text.indexOf(v)
  console.log(`\n  「${v}」在原文中的上下文：`)
  console.log('   ', JSON.stringify(text.slice(Math.max(0, idx - 160), idx + 80)))
}
console.log('\n--- 原始文本前 700 字 ---')
console.log(JSON.stringify(text.slice(0, 700)))

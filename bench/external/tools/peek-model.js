/**
 * 调试工具：把一次模型调用的**原始返回**打出来（含 reasoning_content 与 finish_reason）。
 *
 * 背景：DeepSeek 系模型会先输出 reasoning_content，若 max_tokens 太小，
 * 会出现"花光了 token 但 content 为空"的情况——这正是 CFLUE 首轮跑出 4% 的原因。
 *
 *   node bench/external/tools/peek-model.js --model deepseek-flash --max 32
 *   node bench/external/tools/peek-model.js --user "自定义提问"
 */
const { ModelClient } = require('../lib/model')

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

const DEFAULT_USER = `本题为单项选择题，有且只有一个正确答案。

题目：在选项中鉴别哪一种进口货物是不必支付进口关税的？
选项：
A. 关税金额等同于80人民币的机票
B. 商业价值一定的货样
C. 因储存疏忽导致损坏的商品
D. 外国政府免费赠送的物资`

;(async () => {
  const model = arg('--model', 'deepseek-flash')
  const max = Number(arg('--max', 32))
  const user = arg('--user', DEFAULT_USER)
  const c = new ModelClient({ model })
  const r = await c.chat({ system: '你是金融领域知识评测的答题者。只输出答案字母，不要任何解释、不要复述题目。', user, maxTokens: max, kind: 'peek' })
  const ch = (r.raw.choices || [])[0] || {}
  console.log(`model=${model} maxTokens=${max}`)
  console.log(`finish_reason = ${ch.finish_reason}`)
  console.log(`content       = ${JSON.stringify(r.text)}`)
  console.log(`reasoning     = ${JSON.stringify(r.reasoning).slice(0, 400)}`)
  console.log(`usage         = ${JSON.stringify(r.usage)}`)
  console.log(`message keys  = ${Object.keys(ch.message || {}).join(', ')}`)
})()

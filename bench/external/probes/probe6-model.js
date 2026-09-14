/**
 * 第六轮探测：模型侧三条通道是否真的能用（文本 / 图片 / 函数调用），两个模型都测。
 * 这是整个"外部对齐"能否成立的前提，先花几十个 token 把它钉死。
 */
const { ModelClient, REPO } = require('../lib/model')
const path = require('node:path')

const MODELS = ['deepseek-flash', 'deepseek-v4-pro']

async function testModel(name) {
  console.log(`\n########## ${name} ##########`)
  let c
  try { c = new ModelClient({ model: name }) } catch (e) { console.log('  ❌ 初始化失败: ' + e.message); return null }
  console.log(`  Key: ${c.describe().keyMask}  来源: ${c.keySource}`)

  // 1) 文本 + 指令遵循（考"只输出字母"能不能做到，MCQ 判分依赖它）
  try {
    const r = await c.chat({
      system: '你是金融知识评测的答题者。只输出选项字母，不要任何解释。',
      user: '问：资产负债率 = 负债总额 / （）？\nA. 流动资产\nB. 资产总额\nC. 所有者权益\nD. 营业收入',
      maxTokens: 32, kind: 'probe-text',
    })
    console.log(`  ✅ 文本: ${JSON.stringify(r.text.trim().slice(0, 60))}  tokens=${r.usage && r.usage.completion_tokens}`)
  } catch (e) { console.log('  ❌ 文本: ' + e.message) }

  // 2) 图片（用 OmniDocBench demo 里的一张真实财报/文档页）
  const img = path.join(REPO, 'bench/external/cache/raw/omnidocbench/demo.json')
  const imgDir = path.join(REPO, 'bench/external/cache/raw/omnidocbench_pages')
  require('node:fs').mkdirSync(imgDir, { recursive: true })
  const sampleImg = require('node:fs').existsSync(path.join(imgDir, 'p1.jpg'))
    ? path.join(imgDir, 'p1.jpg')
    : null
  if (!sampleImg) {
    console.log('  ⏭  图片测试需要先下载页面图（见 probe7），跳过')
  } else {
    try {
      const r = await c.vision({ user: '这张图里最上方的标题文字是什么？只回答文字本身。', images: [sampleImg], maxTokens: 128, kind: 'probe-vision' })
      console.log(`  ✅ 图片: ${JSON.stringify(r.text.trim().slice(0, 80))}`)
    } catch (e) { console.log('  ❌ 图片: ' + e.message) }
  }

  // 3) 函数调用（BFCL 形态：给一个函数，问一个需要它的自然语言问题）
  try {
    const r = await c.tools({
      system: 'You are a helpful assistant that answers questions by calling the provided functions.',
      user: 'Find the area of a triangle with a base of 10 units and height of 5 units.',
      tools: [{
        type: 'function',
        function: {
          name: 'calculate_triangle_area',
          description: 'Calculate the area of a triangle given its base and height.',
          parameters: {
            type: 'object',
            properties: { base: { type: 'number', description: 'The base of the triangle.' }, height: { type: 'number', description: 'The height of the triangle.' }, unit: { type: 'string', description: 'The unit of the result.', enum: ['units', 'meters', 'centimeters'] } },
            required: ['base', 'height'],
          },
        },
      }],
      toolChoice: 'auto', kind: 'probe-tools',
    })
    console.log(`  ${r.calls.length ? '✅' : '⚠️ '} 函数调用: calls=${r.calls.length} ${JSON.stringify(r.calls).slice(0, 160)}${r.text ? ' | 文本=' + JSON.stringify(r.text.slice(0, 60)) : ''}`)
  } catch (e) { console.log('  ❌ 函数调用: ' + e.message) }

  // 4) 不相关问题时会不会"乱调"（BFCL irrelevance 的核心）
  try {
    const r = await c.tools({
      system: 'You are a helpful assistant.',
      user: 'Calculate the area of a triangle given the base is 10 meters and height is 5 meters.',
      tools: [{
        type: 'function',
        function: { name: 'determine_body_mass_index', description: 'Calculate body mass index given weight and height.', parameters: { type: 'object', properties: { weight: { type: 'number' }, height: { type: 'number' } }, required: ['weight', 'height'] } },
      }],
      toolChoice: 'auto', kind: 'probe-tools',
    })
    console.log(`  ${r.calls.length === 0 ? '✅' : '⚠️ '} 不相关拒调: calls=${r.calls.length}${r.text ? ' 文本=' + JSON.stringify(r.text.slice(0, 80)) : ''}`)
  } catch (e) { console.log('  ❌ 不相关拒调: ' + e.message) }

  return c.describe()
}

;(async () => {
  const out = []
  for (const m of MODELS) out.push({ model: m, desc: await testModel(m) })
  console.log('\n=== 记账 ===')
  for (const o of out) if (o.desc) console.log(`  ${o.model}: ${o.desc.calls} 次调用, in=${o.desc.promptTokens} out=${o.desc.completionTokens}, 估算 ¥${o.desc.estimatedCostCNY}`)
})()

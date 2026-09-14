/**
 * 供应商连通性自检：每个模型发 3 个最小请求（文本 / 图像 / 函数调用），
 * 用来在正式评测前确认"端点对不对、Key 能不能用、视觉与工具到底支不支持"。
 *
 * 这一步很关键：跨供应商时，"模型不支持图片"与"端点把图片丢了"是两种完全不同的失败，
 * 只有分项探测才分得清（我们对 v4-pro 的结论就是这么来的）。
 *
 *   node bench/external/tools/probe-providers.js --models deepseek-flash,gpt-5.6-luna,glm-5.3-flash
 */
const fs = require('node:fs')
const path = require('node:path')
const { ModelClient } = require('../lib/model')

const EXT = path.join(__dirname, '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
/** 自动挑一张真实的整页文档图（OmniDocBench 页面图优先），避免写死路径 */
function pickSampleImage() {
  const dir = path.join(EXT, 'cache', 'raw')
  if (!fs.existsSync(dir)) return null
  const imgs = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
  const omni = imgs.find((f) => f.startsWith('omnidocbench'))
  return path.join(dir, omni || imgs[0] || '')
}
const sample = pickSampleImage()

;(async () => {
  const ids = arg('--models', 'deepseek-flash').split(',').map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const id of ids) {
    console.log(`\n########## ${id} ##########`)
    let c
    try {
      c = new ModelClient({ model: id })
    } catch (e) {
      console.log(`  ❌ 初始化失败：${e.message}`)
      out.push({ id, error: e.message })
      continue
    }
    const d = c.describe()
    console.log(`  供应商 ${d.vendor || '?'} | 端点 ${d.baseUrl} | 模型 ${d.model} | Key ${d.keyMask}（${d.keySource}）`)
    const rec = { id, baseUrl: d.baseUrl, model: d.model, keySource: d.keySource }

    // 1) 文本 + 指令遵循
    try {
      const r = await c.chat({ system: '只输出选项字母，不要解释。', user: '问：1+1=？\nA. 1\nB. 2', maxTokens: 512, kind: 'probe-text' })
      rec.text = { ok: true, answer: r.text.trim().slice(0, 20), finish: r.finishReason, tokens: r.usage && r.usage.completion_tokens }
      console.log(`  ✅ 文本：${JSON.stringify(rec.text.answer)}（finish=${r.finishReason}）`)
    } catch (e) { rec.text = { ok: false, error: String(e.message).slice(0, 160) }; console.log(`  ❌ 文本：${rec.text.error}`) }

    // 2) 图像（用一张真实文档页图，核对 prompt_tokens 是否明显变大）
    if (!sample) console.log('  ⏭  跳过图像：本地没有页面图（先跑 prepare.js --with-assets）')
    else {
      try {
        const r = await c.vision({ user: '这张图最上方的标题文字是什么？只回答文字。', images: [sample], maxTokens: 512, kind: 'probe-vision' })
        const inTok = r.usage ? r.usage.prompt_tokens : null
        rec.vision = { ok: true, inTokens: inTok, out: r.text.trim().slice(0, 60) }
        console.log(`  ${inTok && inTok > 400 ? '✅' : '⚠️ '} 图像：in=${inTok} tokens，输出 ${JSON.stringify(rec.vision.out)}`)
        if (inTok && inTok <= 400) console.log('      ⚠️ 输入 token 过少，图像很可能没有进入上下文（与 v4-pro 当年的表现一致）')
      } catch (e) { rec.vision = { ok: false, error: String(e.message).slice(0, 160) }; console.log(`  ❌ 图像：${rec.vision.error}`) }
    }

    // 3) 函数调用
    try {
      const r = await c.tools({
        system: 'You call functions when appropriate.',
        user: 'What is the area of a triangle with base 10 and height 5?',
        tools: [{ type: 'function', function: { name: 'calculate_triangle_area', description: 'Calculate triangle area.', parameters: { type: 'object', properties: { base: { type: 'number' }, height: { type: 'number' } }, required: ['base', 'height'] } } }],
        toolChoice: 'auto', maxTokens: 1024, kind: 'probe-tools',
      })
      rec.tools = { ok: true, calls: r.calls.length, args: r.calls[0] ? r.calls[0].args : null }
      console.log(`  ${r.calls.length ? '✅' : '⚠️ '} 工具：calls=${r.calls.length} ${JSON.stringify(rec.tools.args)}`)
    } catch (e) { rec.tools = { ok: false, error: String(e.message).slice(0, 160) }; console.log(`  ❌ 工具：${rec.tools.error}`) }

    rec.usage = c.describe()
    out.push(rec)
  }
  const file = path.join(EXT, 'out', 'provider-probe.json')
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { runs: [] }
  prev.runs.push({ at: new Date().toISOString(), results: out })
  fs.writeFileSync(file, JSON.stringify(prev, null, 2))
  console.log(`\n产物 → bench/external/out/provider-probe.json`)
})().catch((e) => { console.error(e); process.exit(1) })

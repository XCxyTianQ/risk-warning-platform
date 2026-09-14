/**
 * 网关（OpenCode Zen）就绪核查：
 *  1. 拉 /models 元数据（含价格与能力标记）
 *  2. 对候选模型逐个试 /chat/completions（有些家族只支持 /responses，必须实测）
 *  3. 文本 / 图像 / 工具三项能力探测
 * 不打印密钥；输出对 Key 掩码。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const BASE = 'https://opencode.ai/zen/v1'
const KEY_FILE = path.join(os.homedir(), 'Desktop', 'KEY-OPENCODE.txt')
const key = (fs.readFileSync(KEY_FILE, 'utf8').match(/sk-[A-Za-z0-9_\-]{8,}/) || [''])[0]
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'rwp-bench' }
const mask = `${key.slice(0, 6)}…${key.slice(-4)}`

const WANT = ['gpt-5.6-luna', 'glm-5.3-flash', 'deepseek-v4-flash', 'gpt-5.6-sol', 'deepseek-v4-pro']

const imgDir = path.join(__dirname, '..', 'cache', 'raw')
/** 自动挑一张真实整页文档图：OmniDocBench 页面图优先，其次 FinEval-MM 图表 */
const img = (() => {
  if (!fs.existsSync(imgDir)) return null
  const all = fs.readdirSync(imgDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
  if (!all.length) return null
  return path.join(imgDir, all.find((f) => f.startsWith('omnidocbench')) || all[0])
})()

async function post(url, body) {
  const t0 = Date.now()
  const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, text, ms: Date.now() - t0 }
}

;(async () => {
  console.log(`网关：${BASE}   Key：${mask}\n`)

  // 1) 元数据
  console.log('=== /models 元数据（关心的几个）===')
  let meta = null
  try {
    const res = await fetch(`${BASE}/models`, { headers: H })
    meta = await res.json()
    const list = meta.data || meta.models || []
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'gateway-models.json'), JSON.stringify(meta, null, 2))
    for (const id of WANT) {
      const m = list.find((x) => (x.id || x.name) === id)
      if (!m) { console.log(`  ${id.padEnd(24)} 未在列表里`); continue }
      const keys = Object.keys(m).filter((k) => !['id', 'object'].includes(k))
      console.log(`  ${id.padEnd(24)} 字段：${keys.join(', ')}`)
      const price = m.pricing || m.price || null
      console.log(`      价格：${price ? JSON.stringify(price).slice(0, 160) : '（元数据未含价格）'}`)
    }
  } catch (e) {
    console.log(`  ❌ 元数据抓取失败：${e.message}`)
  }

  // 2) /chat/completions 连通性
  console.log('\n=== /chat/completions 连通性（每模型一个最小请求）===')
  for (const id of WANT) {
    try {
      const r = await post(`${BASE}/chat/completions`, { model: id, messages: [{ role: 'user', content: '只回答：OK' }], max_tokens: 64 })
      if (r.status === 200) {
        const j = JSON.parse(r.text)
        const msg = (j.choices && j.choices[0] && j.choices[0].message) || {}
        console.log(`  ✅ ${id.padEnd(24)} ${r.ms}ms  content=${JSON.stringify((msg.content || '').slice(0, 40))}  in=${j.usage && j.usage.prompt_tokens} out=${j.usage && j.usage.completion_tokens}`)
      } else {
        console.log(`  ❌ ${id.padEnd(24)} HTTP ${r.status}  ${r.text.slice(0, 170).replace(/\s+/g, ' ')}`)
      }
    } catch (e) {
      console.log(`  ❌ ${id.padEnd(24)} ${String(e.message).slice(0, 100)}`)
    }
  }

  // 3) 视觉能力（用 prompt_tokens 判断图片是否真的进上下文）
  console.log('\n=== 视觉能力（真实文档页图）===')
  if (!img) console.log('  ⏭  没有本地页面图')
  else {
    const b64 = fs.readFileSync(img).toString('base64')
    for (const id of WANT.slice(0, 3)) {
      try {
        const r = await post(`${BASE}/chat/completions`, {
          model: id,
          messages: [{ role: 'user', content: [{ type: 'text', text: '这张图最上方的标题是什么？只回答文字。' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
          max_tokens: 256,
        })
        if (r.status !== 200) { console.log(`  ❌ ${id.padEnd(24)} HTTP ${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`); continue }
        const j = JSON.parse(r.text)
        const inTok = j.usage && j.usage.prompt_tokens
        const out = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').slice(0, 60)
        console.log(`  ${inTok > 400 ? '✅' : '⚠️ '} ${id.padEnd(24)} in=${inTok} tokens  ${JSON.stringify(out)}`)
        if (inTok <= 400) console.log('      ⚠️ 输入 token 过少 → 图片很可能没有进入上下文')
      } catch (e) {
        console.log(`  ❌ ${id.padEnd(24)} ${String(e.message).slice(0, 100)}`)
      }
    }
  }

  // 4) 工具调用
  console.log('\n=== 工具调用（函数调用格式）===')
  for (const id of WANT.slice(0, 3)) {
    try {
      const r = await post(`${BASE}/chat/completions`, {
        model: id,
        messages: [{ role: 'user', content: 'What is the area of a triangle with base 10 and height 5?' }],
        tools: [{ type: 'function', function: { name: 'calculate_triangle_area', description: 'Calculate triangle area.', parameters: { type: 'object', properties: { base: { type: 'number' }, height: { type: 'number' } }, required: ['base', 'height'] } } }],
        tool_choice: 'auto',
        max_tokens: 512,
      })
      if (r.status !== 200) { console.log(`  ❌ ${id.padEnd(24)} HTTP ${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`); continue }
      const j = JSON.parse(r.text)
      const calls = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.tool_calls) || []
      console.log(`  ${calls.length ? '✅' : '⚠️ '} ${id.padEnd(24)} calls=${calls.length} ${calls[0] ? JSON.stringify(calls[0].function).slice(0, 120) : ''}`)
    } catch (e) {
      console.log(`  ❌ ${id.padEnd(24)} ${String(e.message).slice(0, 100)}`)
    }
  }
})().catch((e) => { console.error(e); process.exit(1) })

/**
 * 探测聚合网关（OpenCode Zen）：找到正确的 baseUrl 并列出可用模型。
 * 只读取桌面 Key 文件，不打印密钥内容；输出里对 Key 做掩码。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; rwp-bench probe)' }
const KEY_FILE = process.env.RWP_KEY_FILE_OPENCODE || path.join(os.homedir(), 'Desktop', 'KEY-OPENCODE.txt')

function loadKey() {
  const txt = fs.readFileSync(KEY_FILE, 'utf8')
  const m = txt.match(/sk-[A-Za-z0-9_\-]{8,}/)
  return m ? m[0] : ''
}
const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '(未找到)')

const CANDIDATE_BASES = [
  'https://opencode.ai/zen/v1',
  'https://api.opencode.ai/v1',
  'https://open-code.ai/api/v1',
  'https://opencode.ai/api/v1',
  'https://zen.opencode.ai/v1',
  'https://api.opencode.ai/zen/v1',
]

const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

;(async () => {
  const key = loadKey()
  console.log(`Key 文件：${KEY_FILE}`)
  console.log(`Key：${mask(key)}\n`)

  // 1) 官方文档页
  console.log('=== OpenCode Zen 官方文档 ===')
  for (const url of ['https://open-code.ai/en/docs/zen', 'https://opencode.ai/docs/zen']) {
    try {
      const res = await fetch(url, { headers: UA })
      const html = await res.text()
      const text = strip(html)
      console.log(`  ${res.status} ${url}（${(html.length / 1024).toFixed(0)}KB）`)
      const sents = text.split(/(?<=[.!?])\s+/).filter((s) => /(base|endpoint|api\.|https:\/\/|model|price|pricing|\$|token|GPT|GLM|Claude|Gemini|DeepSeek|Kimi|Qwen)/i.test(s))
      sents.slice(0, 26).forEach((s) => console.log('   · ' + s.slice(0, 220)))
      break
    } catch (e) {
      console.log(`  ❌ ${url}: ${String(e.message).slice(0, 80)}`)
    }
  }

  // 2) 逐个候选端点试 /models
  console.log('\n=== 候选端点探测（GET /models）===')
  for (const base of CANDIDATE_BASES) {
    try {
      const res = await fetch(`${base}/models`, { headers: { ...UA, Authorization: `Bearer ${key}` } })
      const text = await res.text()
      let ids = []
      try {
        const j = JSON.parse(text)
        ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
      } catch { /* 非 JSON */ }
      console.log(`  ${res.status === 200 ? '✅' : '❌'} ${base.padEnd(38)} HTTP ${res.status}${ids.length ? `  模型 ${ids.length} 个` : ''}`)
      if (ids.length) {
        console.log(`      ${ids.slice(0, 40).join(', ')}`)
        const want = ids.filter((x) => /luna|glm|gpt-5|claude|deepseek/i.test(x))
        console.log(`      与本次相关的：${want.join(', ') || '（无匹配）'}`)
      } else if (res.status !== 404) {
        console.log(`      ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
      }
    } catch (e) {
      console.log(`  ❌ ${base.padEnd(38)} ${String(e.message).slice(0, 70)}`)
    }
  }
})()

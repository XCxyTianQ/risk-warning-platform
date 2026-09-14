/** 抓取 Fable 5.1 / GPT-6 Astra 的官方或第三方定价页面，抽取价格事实。 */
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const PAGES = [
  ['Anthropic 官方：Claude Fable 5.1 概览', 'https://platform.claude.com/docs/en/models/fable-5-1/overview'],
  ['apidog：Claude Fable 5.1 规格与定价', 'https://apidog.com/blog/what-is-claude-fable-5-1/'],
  ['apidog：GPT-6 Astra 面向开发者（API/定价/1M 上下文）', 'https://apidog.com/blog/gpt-6-astra-api/'],
  ['CloudZero：GPT-6 定价', 'https://www.cloudzero.com/blog/gpt-6-pricing/'],
  ['OrcaRouter：GPT-6 Astra 价格与基准', 'https://www.orcarouter.ai/models/openai/gpt-6-astra'],
  ['OrcaRouter：Claude Fable 5.1 价格与基准', 'https://www.orcarouter.ai/models/anthropic/claude-fable-5.1'],
]

const strip = (h) => String(h)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ').trim()

const KEY = /(\$|price|pricing|per million|1M tokens|input|output|cached|上下文|context|定价|价格|每百万|输入|输出|缓存|发布|released|benchmark|基准|得分)/i

;(async () => {
  const out = []
  for (const [label, url] of PAGES) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rwp-bench)' } })
      const html = await res.text()
      const text = strip(html)
      const sents = text.split(/(?<=[.!?。])\s+/).filter((s) => KEY.test(s) && s.length > 15 && s.length < 320)
      console.log(`\n=== ${label} ===`)
      console.log(`  HTTP ${res.status}  ${(html.length / 1024).toFixed(0)}KB  正文 ${text.length} 字`)
      // 优先打印含美元数字的句子
      const money = sents.filter((s) => /\$\s?\d/.test(s))
      ;(money.length ? money : sents).slice(0, 12).forEach((s) => console.log('   · ' + s.trim().slice(0, 230)))
      out.push({ label, url, status: res.status, money: money.slice(0, 20), key: sents.slice(0, 40) })
    } catch (e) {
      console.log(`\n=== ${label} ===\n  ❌ ${String(e.message).slice(0, 110)}`)
      out.push({ label, url, error: String(e.message).slice(0, 150) })
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'out', 'frontier-pricing-probe.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), pages: out }, null, 2))
  console.log('\n产物 → bench/external/out/frontier-pricing-probe.json')
})()

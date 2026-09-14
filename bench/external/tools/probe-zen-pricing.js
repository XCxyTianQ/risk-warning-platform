/**
 * 查 Claude Fable 5.1 与 GPT-6 Astra 的可核价目。
 * 网关文档价格表此前没有这两行，需要确认是"未定价"还是"我漏抓了"。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const key = (fs.readFileSync(path.join(os.homedir(), 'Desktop', 'KEY-OPENCODE.txt'), 'utf8').match(/sk-[A-Za-z0-9_-]+/) || [''])[0]

;(async () => {
  const res = await fetch('https://open-code.ai/en/docs/zen', { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const html = await res.text()
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()))
    .filter((r) => r.length)

  console.log('=== 价格表：Fable / Astra / 6 相关 ===')
  const hits = rows.filter((r) => /fable|astra|gpt\s?6/i.test(r.join(' ')))
  if (!hits.length) console.log('  （没有任何匹配行）')
  hits.forEach((r) => console.log('  ', r.join(' | ').slice(0, 160)))

  console.log('\n=== 端点表：Fable / Astra ===')
  rows.filter((r) => r.length === 4 && /fable|astra/i.test(r.join(' '))).forEach((r) => console.log('  ', r.join(' | ').slice(0, 160)))

  console.log('\n=== 页面上出现 Fable 5.1 / Astra 的句子 ===')
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
  const sents = text.split(/(?<=[.!?。])\s+/).filter((s) => /fable\s?5\.1|astra/i.test(s))
  sents.slice(0, 12).forEach((s) => console.log('  · ' + s.trim().slice(0, 200)))
  if (!sents.length) console.log('  （页面正文没有提到这两者的价格）')

  // /models 元数据
  const mres = await fetch('https://opencode.ai/zen/v1/models', { headers: { Authorization: `Bearer ${key}` } })
  const mj = await mres.json()
  console.log('\n=== /models 元数据 ===')
  for (const id of ['claude-fable-5-1', 'claude-fable-5', 'gpt-6-astra']) {
    const m = (mj.data || []).find((x) => x.id === id)
    console.log('  ', id.padEnd(20), m ? JSON.stringify(m).slice(0, 200) : '不在列表中')
  }
  fs.writeFileSync(path.join(__dirname, '..', 'out', 'zen-price-probe.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), priceRows: rows, hits }, null, 2))
})()

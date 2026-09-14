/**
 * 抽取 OpenCode Zen 的完整价格表并归档（成本记账必须用**网关价**，不能用官方价）。
 * 同时摸清每个模型族的端点路径（/chat/completions 还是 /responses 或 /messages）。
 */
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const OUT = path.join(__dirname, '..', 'out', 'gateway-catalog.json')

;(async () => {
  const res = await fetch('https://open-code.ai/en/docs/zen', { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const html = await res.text()
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()))
    .filter((r) => r.length)

  // 端点表：4 列（名称/id/端点/包）
  const endpoints = rows.filter((r) => r.length === 4 && /https:\/\/opencode\.ai\/zen/.test(r[2]))
    .map((r) => ({ name: r[0], id: r[1], url: r[2], sdk: r[3] }))
  // 价格表：首列是模型名（含括号说明），后面是数字/Free
  const prices = rows.filter((r) => r.length >= 3 && r[0] && !/https:\/\//.test(r.join(' ')) && /^\$|Free|-/.test(r[1] || ''))
    .map((r) => ({ model: r[0], input: r[1], output: r[2], cachedRead: r[3] || null, cachedWrite: r[4] || null }))

  console.log('=== 端点分组（按 API 形态）===')
  const byApi = {}
  for (const e of endpoints) {
    const api = e.url.replace('https://opencode.ai/zen/v1', '') || '/'
    byApi[api] = byApi[api] || []
    byApi[api].push(e.id)
  }
  for (const [api, ids] of Object.entries(byApi)) {
    console.log(`  ${api.padEnd(20)} ${ids.length} 个：${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ' …' : ''}`)
  }

  console.log('\n=== 价格表（我们关心的模型）===')
  const want = prices.filter((p) => /luna|glm|deepseek|terra|sol|fable|opus-5|qwen|kimi/i.test(p.model))
  want.forEach((p) => console.log(`  ${p.model.padEnd(42)} 输入 ${String(p.input).padEnd(8)} 输出 ${String(p.output).padEnd(8)} 缓存读 ${p.cachedRead || '-'} 缓存写 ${p.cachedWrite || '-'}`))

  // 我们真正要用的三个
  const pick = (re) => prices.find((p) => re.test(p.model))
  const chosen = {
    'gpt-5.6-luna': pick(/GPT 5\.6 Luna \(≤ 272K/),
    'glm-5.3-flash': pick(/GLM[- ]?5\.3[- ]?Flash/i),
    'deepseek-v4-flash': pick(/DeepSeek V4 Flash \(Peak/),
  }
  console.log('\n=== 本次同代测试将使用的价目 ===')
  for (const [id, p] of Object.entries(chosen)) {
    console.log(`  ${id.padEnd(20)} ${p ? `${p.input} / ${p.output}（缓存读 ${p.cachedRead || '-'}）` : '⚠️ 未在价格表中找到'}`)
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'https://open-code.ai/en/docs/zen',
    note: '网关价目与端点形态；用于同代测试的成本记账（网关价 ≠ 官方价）',
    apiPaths: Object.fromEntries(Object.entries(byApi).map(([k, v]) => [k, v])),
    endpoints,
    prices,
    chosen,
  }, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(__dirname, '..', '..'), OUT)}`)
})()

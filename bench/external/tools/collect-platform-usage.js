/**
 * 读取"平台链路复测"（口径 B）在临时库里留下的 LLM 用量。
 *
 * 为什么需要它：口径 A 的 token 由 harness 自己记账，而口径 B 是经平台后端跑的，
 * 用量写在平台数据库的 chat_session 表里。既然要求"成本算得清"，就不能只报一半。
 *
 *   node bench/external/tools/collect-platform-usage.js
 * 产物：bench/external/out/platform-usage.json
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const OUT = path.join(__dirname, '..', 'out')
const PRICE = { in: 0.5, out: 2 } // 元/百万 token（deepseek-flash 公开价目）

const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('platform-chain-')).sort()
const results = []
for (const d of dirs) {
  const db = path.join(OUT, d, 'platform.db')
  const meta = path.join(OUT, d)
  if (!fs.existsSync(db)) continue
  try {
    const conn = new DatabaseSync(db)
    const row = conn.prepare('SELECT COUNT(*) n, COALESCE(SUM(llm_calls),0) calls, COALESCE(SUM(prompt_tokens),0) pt, COALESCE(SUM(completion_tokens),0) ct, COALESCE(SUM(cache_hit_tokens),0) hit, COALESCE(SUM(cache_miss_tokens),0) miss FROM chat_session').get()
    conn.close()
    const cost = (row.pt / 1e6) * PRICE.in + (row.ct / 1e6) * PRICE.out
    results.push({
      run: d,
      sessions: row.n,
      llmCalls: row.calls,
      promptTokens: row.pt,
      completionTokens: row.ct,
      cacheHitTokens: row.hit,
      cacheMissTokens: row.miss,
      cacheHitRatePct: row.hit + row.miss ? Number(((row.hit / (row.hit + row.miss)) * 100).toFixed(1)) : null,
      estimatedCostCNY: Number(cost.toFixed(4)),
    })
  } catch (e) {
    results.push({ run: d, error: String(e.message).slice(0, 200) })
  }
}

results.sort((a, b) => (a.llmCalls || 0) - (b.llmCalls || 0))
const latest = results[results.length - 1] || null
fs.writeFileSync(path.join(OUT, 'platform-usage.json'), JSON.stringify({ generatedAt: new Date().toISOString(), note: '口径 B 的平台侧 LLM 用量，直接读平台数据库（chat_session 表）', runs: results, latest }, null, 2))
for (const r of results) {
  console.log(r.error ? `❌ ${r.run}: ${r.error}` : `✅ ${r.run}: ${r.llmCalls} 次调用, in=${r.promptTokens}, out=${r.completionTokens}, 缓存命中 ${r.cacheHitRatePct}%, 估算 ¥${r.estimatedCostCNY}`)
}
console.log(`\n最新一次（用于报告）：${latest ? latest.run : '无'}`)

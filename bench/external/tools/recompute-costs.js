/**
 * 用**正确的价目**重算已入库产物的成本（缓存命中/未命中分开计价）。
 *
 * 背景：最初按"¥0.5/¥2 每百万 token"的粗估记账，官方 Flash 实际是
 *   cache-hit $0.006 / cache-miss $0.30 / 输出 $1.20（peak）
 * 两者相差数倍，且我们输入侧缓存命中率约 68%，必须分开算。
 *
 *   node bench/external/tools/recompute-costs.js [--write]
 */
const fs = require('node:fs')
const path = require('node:path')
const { costOf } = require('../lib/model')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const write = process.argv.includes('--write')

const TARGETS = [
  path.join(EXT, 'reports', 'external-alignment-v1.json'),
  path.join(OUT, 'platform-usage.json'),
  path.join(OUT, 'prompt-sensitivity.json'),
  path.join(OUT, 'financebench-history.json'),
  path.join(OUT, 'external-reference-numbers.json'),
]

let totalUSD = 0
let totalCNY = 0

/** 平台侧用量（口径 B）没有 model 字段，它的行结构是 llmCalls/promptTokens/...，单独处理 */
function fixPlatformUsage(j) {
  let n = 0
  const fixRun = (r) => {
    if (!r || r.llmCalls === undefined) return r
    const c = costOf({ model: 'deepseek-flash', promptTokens: r.promptTokens || 0, cacheHitTokens: r.cacheHitTokens || 0, completionTokens: r.completionTokens || 0 })
    if (!c) return r
    if (r.estimatedCostCNY !== c.cny) n++
    return { ...r, cacheMissTokens: c.missTokens, estimatedCostCNY: c.cny, estimatedCostUSD: c.usd, pricePerTokenSource: 'deepseek-flash peak 价（2026-09-14）' }
  }
  const runs = (j.runs || []).map(fixRun)
  return { ...j, runs, latest: fixRun(j.latest), recomputedAt: new Date().toISOString(), _fixed: n }
}

for (const file of TARGETS) {
  if (!fs.existsSync(file)) continue
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const before = JSON.stringify(j).length
  let touched = 0

  const fix = (u) => {
    if (!u || !u.model || u.promptTokens === undefined) return u
    const c = costOf({ model: u.model, promptTokens: u.promptTokens, cacheHitTokens: u.cacheHitTokens || 0, completionTokens: u.completionTokens || 0 })
    if (!c) return u
    if (u.estimatedCostCNY !== c.cny || u.estimatedCostUSD !== c.usd) touched++
    return { ...u, cacheMissTokens: c.missTokens, estimatedCostCNY: c.cny, estimatedCostUSD: c.usd, pricePerMTokUSD: c.price, priceSource: 'https://api-docs.deepseek.com/quick_start/pricing（2026-09-14）' }
  }

  // 递归找所有像 usage 的对象
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map((x) => walk(x, key))
    if (node && typeof node === 'object') {
      if (node.model && node.promptTokens !== undefined && node.calls !== undefined) return fix(node)
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k)
      return out
    }
    return node
  }
  let fixed = walk(j, '')
  if (path.basename(file) === 'platform-usage.json') {
    fixed = fixPlatformUsage(j)
    console.log(`platform-usage.json: 重算 ${fixed._fixed} 处`)
    delete fixed._fixed
  }
  // 汇总这家文件里的成本
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node && typeof node === 'object') {
      if (node.model && node.estimatedCostUSD !== undefined) { totalUSD += node.estimatedCostUSD || 0; totalCNY += node.estimatedCostCNY || 0 }
      else Object.values(node).forEach(collect)
    }
  }
  collect(fixed)
  console.log(`${path.basename(file)}: 重算 ${touched} 处${write ? '' : '（未写入，加 --write 生效）'}`)
  if (write) fs.writeFileSync(file, JSON.stringify(fixed, null, 2))
  void before
}
console.log(`\n这些产物合计（去重前）：$${totalUSD.toFixed(2)} ≈ ¥${totalCNY.toFixed(2)}`)
console.log('注：同一份用量可能出现在多个产物里，上面是"按文件累加"，不是去重后的总额。')

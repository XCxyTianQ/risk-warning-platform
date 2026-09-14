/**
 * 超限挑战成本评估：按**我们自己的实测 token 消耗**推算 Fable 5.1 / GPT-6 Astra 的花费。
 *
 * 为什么必须用实测：顶级模型的成本由**输出 token** 主导，而输出里绝大部分是推理 token
 * （我们自己的运行里推理占输出 86%）。按"每题大概几百 token"猜会低估一个数量级。
 *
 *   node bench/external/tools/estimate-frontier-cost.js [--reasoning 1.5]
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const reasoningMultiplier = Number(arg('--reasoning', '1'))

/** 官方/第三方公布的价目（美元每百万 token） */
const PRICES = {
  'claude-fable-5-1': { in: 10, cacheRead: 0.25, out: 50, note: 'Anthropic 官方（apidog/OrcaRouter 核对）：$10 / 缓存读 $0.25 / $50；批量 $5/$25' },
  'gpt-6-astra': { in: 10, cacheRead: 1, out: 50, note: 'OpenAI 标准档（≤272K）：$10 / 缓存读 $1 / $50；>272K 为 $20/$2/$75；Batch/Flex 半价' },
  'gpt-5.6-luna': { in: 0.2, cacheRead: 0.02, out: 1.2, note: '网关价（对照用）' },
  'deepseek-flash': { in: 0.3, cacheRead: 0.006, out: 1.2, note: '官方 peak 价（对照用）' },
}

/** 从我们自己的运行明细里读每个基准的实测 token 画像 */
function measuredProfile() {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  const picked = new Map()
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(OUT, d))) {
      const m = f.match(/^(.+)\.(deepseek-flash)\.json$/)
      if (!m) continue
      picked.set(m[1], path.join(OUT, d, f)) // 后面的覆盖前面的 → 取最新
    }
  }
  const profile = {}
  for (const [bench, file] of picked) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rows = (j.rows || []).filter((r) => r.usage && !r.error)
    if (!rows.length) continue
    const sum = rows.reduce((a, r) => ({
      in: a.in + (r.usage.prompt_tokens || 0),
      out: a.out + (r.usage.completion_tokens || 0),
      hit: a.hit + (r.usage.prompt_cache_hit_tokens || 0),
    }), { in: 0, out: 0, hit: 0 })
    profile[bench] = {
      n: rows.length,
      inPerCall: Math.round(sum.in / rows.length),
      outPerCall: Math.round(sum.out / rows.length),
      cacheHitRate: sum.in ? sum.hit / sum.in : 0,
      totalIn: sum.in, totalOut: sum.out,
    }
  }
  return profile
}

/** 计划：每个场景跑哪些基准、抽多少题 */
const PLANS = [
  { id: 'P0 连通性与能力自检', desc: '文本/图像/工具各 1 次 × 2 模型', benches: { probe: { calls: 6, inPerCall: 1200, outPerCall: 800, cacheHitRate: 0 } } },
  { id: 'P1 锚定小样', desc: 'FinanceBench oracle 50 题 + BFCL 200 题（方向性读数）', benches: { financebench: { scale: 50 / 150 }, bfcl: { scale: 200 / 520 } } },
  { id: 'P2 锚定全量', desc: 'FinanceBench oracle 150 题 + BFCL 520 题（与同代测试同口径）', benches: { financebench: { scale: 1 }, bfcl: { scale: 1 } } },
  { id: 'P3 完整六组', desc: 'CFLUE + FinEval + BFCL + FinanceBench + FinEval-MM + OmniDocBench', benches: { cflue: { scale: 1 }, fineval: { scale: 1 }, bfcl: { scale: 1 }, financebench: { scale: 1 }, 'fineval-mm': { scale: 1 }, omnidocbench: { scale: 1 } } },
]

function costFor(model, calls, inPerCall, outPerCall, cacheHitRate) {
  const p = PRICES[model]
  const inTok = calls * inPerCall
  const outTok = calls * outPerCall * reasoningMultiplier
  const hitTok = inTok * cacheHitRate
  const missTok = inTok - hitTok
  const usd = (hitTok / 1e6) * p.cacheRead + (missTok / 1e6) * p.in + (outTok / 1e6) * p.out
  return { usd, inTok, outTok, hitTok, missTok }
}

;(async () => {
  const profile = measuredProfile()
  console.log('=== 实测 token 画像（来自我们自己跑过的明细，非估算）===')
  console.log('基准                调用数   输入/次   输出/次   缓存命中率   输入合计     输出合计')
  for (const [b, v] of Object.entries(profile)) {
    console.log('  ' + b.padEnd(18) + String(v.n).padEnd(9) + String(v.inPerCall).padEnd(10) + String(v.outPerCall).padEnd(10) + (v.cacheHitRate * 100).toFixed(0).padStart(6) + '%   ' + String(v.totalIn).padStart(10) + '  ' + String(v.totalOut).padStart(10))
  }

  const models = ['claude-fable-5-1', 'gpt-6-astra']
  console.log(`\n=== 成本评估（推理量系数 ×${reasoningMultiplier}；价目：Fable 5.1 $10/$0.25/$50，Astra $10/$1/$50）===`)
  const rows = []
  for (const plan of PLANS) {
    const line = { plan: plan.id, desc: plan.desc, perModel: {}, total: 0 }
    for (const model of models) {
      let usd = 0
      for (const [bench, spec] of Object.entries(plan.benches)) {
        const base = profile[bench] || spec
        const calls = spec.calls || Math.round(base.n * (spec.scale || 1))
        const c = costFor(model, calls, base.inPerCall || spec.inPerCall, base.outPerCall || spec.outPerCall, base.cacheHitRate || 0)
        usd += c.usd
      }
      line.perModel[model] = usd
      line.total += usd
    }
    rows.push(line)
    console.log(`  ${plan.id.padEnd(18)} ${plan.desc}`)
    console.log(`      Fable 5.1 $${line.perModel['claude-fable-5-1'].toFixed(2)}   Astra $${line.perModel['gpt-6-astra'].toFixed(2)}   两者合计 $${line.total.toFixed(2)}（≈ ¥${(line.total * 7.1).toFixed(0)}）`)
  }

  console.log('\n=== 分基准成本（单模型，全量；用来决定哪些该跑、哪些该砍）===')
  const byBench = []
  for (const [bench, v] of Object.entries(profile)) {
    const c = costFor('gpt-6-astra', v.n, v.inPerCall, v.outPerCall, v.cacheHitRate)
    const cF = costFor('claude-fable-5-1', v.n, v.inPerCall, v.outPerCall, v.cacheHitRate)
    byBench.push({ bench, calls: v.n, outPerCall: v.outPerCall, astraUSD: Number(c.usd.toFixed(2)), fableUSD: Number(cF.usd.toFixed(2)) })
    console.log('  ' + bench.padEnd(16) + String(v.n).padStart(5) + ' 次  输出/次 ' + String(v.outPerCall).padStart(5) + '   Astra $' + c.usd.toFixed(2).padStart(7) + '   Fable $' + cF.usd.toFixed(2).padStart(7))
  }
  const sorted = [...byBench].sort((a, b) => b.astraUSD - a.astraUSD)
  console.log(`  最贵的是 ${sorted[0].bench}（$${sorted[0].astraUSD}），最便宜的是 ${sorted[sorted.length - 1].bench}（$${sorted[sorted.length - 1].astraUSD}）`)

  console.log('\n=== 推理量敏感性（P2 锚定全量，两模型合计）===')
  const sensitivity = []
  for (const mult of [0.5, 1, 1.5, 2, 3]) {
    let total = 0
    for (const model of models) {
      let usd = 0
      for (const bench of Object.keys(PLANS[2].benches)) {
        const base = profile[bench]
        if (!base) continue
        // 推理量只放大输出侧
        usd += costFor(model, base.n, base.inPerCall, base.outPerCall * mult, base.cacheHitRate).usd
      }
      total += usd
    }
    sensitivity.push({ multiplier: mult, totalUSD: Number(total.toFixed(2)) })
    console.log(`  推理量 ×${mult}: $${total.toFixed(2)}（≈ ¥${(total * 7.1).toFixed(0)}）`)
  }

  fs.writeFileSync(path.join(OUT, 'frontier-cost-estimate.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    reasoningMultiplier,
    prices: PRICES,
    measuredProfile: profile,
    plans: PLANS.map((p) => ({ id: p.id, desc: p.desc, benchSpec: p.benches })),
    estimates: rows.map((r) => ({ id: r.plan, desc: r.desc, fableUSD: Number(r.perModel['claude-fable-5-1'].toFixed(2)), astraUSD: Number(r.perModel['gpt-6-astra'].toFixed(2)), totalUSD: Number(r.total.toFixed(2)) })),
    byBenchmark: byBench,
    sensitivity,
    note: '依据我们自己的实测 token 画像 ×公开价目；网关对这两个型号未公布价目，实际计费以工作区账单为准',
  }, null, 2))
  console.log('\n产物 → bench/external/out/frontier-cost-estimate.json')
})()

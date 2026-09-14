/**
 * 用两个顶级模型的**实测 token 画像**重算成本，替换掉"按我方推理画像外推"的高估版本。
 *
 *   node bench/external/tools/recalibrate-frontier-cost.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')
const EXP = path.join(OUT, 'experiments')

const PRICES = {
  'claude-fable-5-1': { in: 10, cacheRead: 0.25, out: 50 },
  'gpt-6-astra': { in: 10, cacheRead: 1, out: 50 },
}

/** 从试点产物里读实测画像 */
function pilotProfile(model) {
  const files = fs.readdirSync(EXP).filter((f) => f.endsWith('.json')).sort()
  // 试点文件的 usage.author 里记录了模型名 == model
  for (const f of files.slice().reverse()) {
    const j = JSON.parse(fs.readFileSync(path.join(EXP, f), 'utf8'))
    const u = j.usage && j.usage.author
    if (u && u.model === model && j.rows && j.rows.length) {
      const rows = j.rows.filter((r) => !r.error)
      const out = rows.reduce((s, r) => s + ((r.usage && r.usage.completion_tokens) || 0), 0)
      return {
        file: f,
        n: rows.length,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        reasoningTokens: u.reasoningTokens,
        cacheHitTokens: u.cacheHitTokens,
        inPerCall: Math.round(u.promptTokens / Math.max(1, u.calls)),
        outPerCall: Math.round(u.completionTokens / Math.max(1, u.calls)),
        reasoningPerCall: Math.round((u.reasoningTokens || 0) / Math.max(1, u.calls)),
        cacheHitRate: u.promptTokens ? u.cacheHitTokens / u.promptTokens : 0,
        calls: u.calls,
        observedCostUSD: u.estimatedCostUSD,
        accuracyPct: j.accuracyPct,
        outSumCheck: out,
      }
    }
  }
  return null
}

/** 计划（与之前一致，但用实测画像） */
const PLANS = [
  { id: 'P0 连通性/能力自检', calls: { probe: 6 } },
  { id: 'P1 锚定小样', calls: { financebench: 50, bfcl: 200 } },
  { id: 'P2 锚定全量', calls: { financebench: 300, bfcl: 520 } }, // financebench 含 oracle+closedBook 两个口径
  { id: 'P3 完整六组', calls: { cflue: 423, fineval: 382, bfcl: 520, financebench: 300, 'fineval-mm': 150, omnidocbench: 18 } },
  { id: 'P3-精简（跳过 fineval 与 closedBook）', calls: { cflue: 423, bfcl: 520, financebench: 150, 'fineval-mm': 150, omnidocbench: 18 } },
]

;(async () => {
  const pilots = {}
  for (const m of Object.keys(PRICES)) {
    const p = pilotProfile(m)
    if (!p) { console.log(`⚠️ 没找到 ${m} 的试点数据`); continue }
    pilots[m] = p
  }
  console.log('=== 顶级模型实测画像（5 题试点）===')
  for (const [m, p] of Object.entries(pilots)) {
    console.log(`  ${m}`)
    console.log(`     输入/次 ${p.inPerCall}  输出/次 ${p.outPerCall}（其中推理 ${p.reasoningPerCall}）  缓存命中 ${(p.cacheHitRate * 100).toFixed(0)}%`)
    console.log(`     ${p.calls} 次调用实测花费 $${p.observedCostUSD}；试点准确率 ${p.accuracyPct}%`)
  }
  const dfProfile = { inPerCall: 387, outPerCall: 1339, cacheHitRate: 0.6 }
  console.log(`\n  对照：我方 DeepSeek-V4.1-Flash 在同样题型上是 输入/次 ${dfProfile.inPerCall}、输出/次 ${dfProfile.outPerCall}`)
  for (const [m, p] of Object.entries(pilots)) {
    console.log(`     → ${m} 的输出量是我方的 ${(p.outPerCall / dfProfile.outPerCall).toFixed(2)} 倍`)
  }

  const cost = (model, calls, prof) => {
    const pr = PRICES[model]
    const inTok = calls * prof.inPerCall
    const outTok = calls * prof.outPerCall
    const hit = inTok * prof.cacheHitRate
    return (hit / 1e6) * pr.cacheRead + ((inTok - hit) / 1e6) * pr.in + (outTok / 1e6) * pr.out
  }

  console.log('\n=== 重算后的成本（基于实测画像）===')
  const table = []
  for (const plan of PLANS) {
    const row = { plan: plan.id, per: {} }
    let total = 0
    for (const [m, p] of Object.entries(pilots)) {
      let usd = 0
      for (const [bench, calls] of Object.entries(plan.calls)) {
        // 各基准的输出量按"题目长度差异"缩放：用我方各基准的输出/次 与 financebench 的比值作为系数
        const scale = bench === 'financebench' ? 1 : bench === 'bfcl' ? 158 / 1339 : bench === 'cflue' ? 532 / 1339 : bench === 'fineval' ? 1181 / 1339 : bench === 'fineval-mm' ? 959 / 1339 : bench === 'omnidocbench' ? 1215 / 1339 : 1
        usd += cost(m, calls, { inPerCall: Math.round(p.inPerCall * (bench === 'probe' ? 3 : 1)), outPerCall: Math.max(60, Math.round(p.outPerCall * scale)), cacheHitRate: p.cacheHitRate })
      }
      row.per[m] = Number(usd.toFixed(2))
      total += usd
    }
    row.total = Number(total.toFixed(2))
    table.push(row)
    console.log(`  ${plan.id.padEnd(34)} Fable $${String(row.per['claude-fable-5-1']).padStart(7)}  Astra $${String(row.per['gpt-6-astra']).padStart(7)}  合计 $${row.total.toFixed(2)}（≈ ¥${(row.total * 7.1).toFixed(0)}）`)
  }

  fs.writeFileSync(path.join(OUT, 'frontier-cost-recalibrated.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: '两个顶级模型各跑 5 题真实 FinanceBench 试点，取实测 token/次 作为画像，再按各基准的相对输出长度缩放',
    prices: PRICES,
    pilots,
    deepseekReference: dfProfile,
    plans: table,
    caveat: '试点仅 5 题，输出长度方差大；结论用于量级判断，正式开跑前建议再跑 20 题确认',
  }, null, 2))
  console.log('\n产物 → bench/external/out/frontier-cost-recalibrated.json')
})()

/**
 * 外部基准对齐的编排入口。
 *
 *   node bench/external/run.js --dry                      # 只抽样，不调用模型（看题量与批次哈希）
 *   node bench/external/run.js --only cflue --small       # 小样本试跑
 *   node bench/external/run.js                            # 全量对齐（默认两个模型）
 *   node bench/external/run.js --only bfcl --models deepseek-flash
 *
 * 产物：
 *   bench/external/out/run-<时间戳>/<基准>.<模型>.json   逐题明细（不入库，体积大）
 *   bench/external/reports/external-alignment-v1.json    聚合指标（入库）
 *   bench/external/reports/external-alignment-v1.md      人读报告（入库）
 */
const fs = require('node:fs')
const path = require('node:path')
const { ModelClient } = require('./lib/model')
const S = require('./sources')

const OUT = path.join(__dirname, 'out')
const REPORTS = path.join(__dirname, 'reports')
const VERSION = 'v1'

const ADAPTERS = ['cflue', 'fineval', 'fineval-mm', 'financebench', 'bfcl', 'omnidocbench']
/**
 * 默认只跑 deepseek-flash（项目指定的唯一模型）。
 * 说明：**不做跨模型对比**，因此"横向对比表"这条验收项改为"口径 A（直连模型）vs 口径 B（平台链路）"，
 * 并显式记录所用模型与版本。若将来获批第二个模型，用 `--models a,b` 即可恢复跨模型对比，
 * 代码里所有与多模型相关的路径都保留着（含"用另一个模型当裁判"的交叉裁判）。
 */
const DEFAULT_MODELS = ['deepseek-flash']
/** 图像类基准：实测 deepseek-v4-pro 不接受图像输入（in=124 tokens 且明确拒绝），故只跑有视觉能力的模型 */
const VISION_MODELS = ['deepseek-flash']

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes(n)

/** 抽样规模档位：small 用于打通链路，full 用于正式出数 */
const PROFILES = {
  small: {
    cflue: { knowledge: 24, application: 25 }, fineval: { numerical: 12, index: 20 },
    'fineval-mm': { multimodal: 20 }, financebench: { questions: 20 },
    bfcl: { simple: 20, multiple: 20, irrelevance: 12 }, omnidocbench: { pages: 4 },
  },
  medium: {
    cflue: { knowledge: 100, application: 50 }, fineval: { numerical: 42, index: 100 },
    'fineval-mm': { multimodal: 60 }, financebench: { questions: 60 },
    bfcl: { simple: 80, multiple: 80, irrelevance: 50 }, omnidocbench: { pages: 8 },
  },
  full: {
    cflue: { knowledge: 300, application: 125 }, fineval: { numerical: 42, index: 340 },
    'fineval-mm': { multimodal: 150 }, financebench: { questions: 150 },
    bfcl: { simple: 200, multiple: 200, irrelevance: 120 }, omnidocbench: { pages: 18 },
  },
}

function loadAdapter(id) {
  const f = path.join(__dirname, 'adapters', `${id}.js`)
  if (!fs.existsSync(f)) return null
  return require(f)
}

async function main() {
  const only = arg('--only', '')
  const ids = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : ADAPTERS
  const profile = has('--small') ? 'small' : has('--medium') ? 'medium' : 'full'
  const sizes = PROFILES[profile]
  const seed = Number(arg('--seed', 20260101))
  const models = (arg('--models', '') ? arg('--models').split(',') : DEFAULT_MODELS).map((s) => s.trim()).filter(Boolean)
  const concurrency = Number(arg('--concurrency', 6))
  const dry = has('--dry')
  const validateOnly = has('--validate-only')
  // --merge：只更新本次跑到的基准，保留报告里其他基准的结果（用于"单独重跑一个基准"）
  const merge = has('--merge')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = path.join(OUT, `run-${stamp}`)
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`=== 外部基准对齐 · 档位 ${profile} · 种子 ${seed} · 模型 ${models.join(', ')} ===`)
  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    profile,
    seed,
    concurrency,
    models,
    benchmarks: {},
    modelUsage: {},
    notes: [
      '所有外部数据均按 repo@ref + sha256 锁定，见 out/manifest.json',
      '本节数字回答的是"模型与读取链路"的能力，平台的端到端能力见 FinRisk-Bench 与 bench/ 套件',
      '图像类基准只跑实测支持图像输入的模型',
    ],
  }

  // --merge：把已有报告里"本次没跑"的基准原样带过来
  const reportFile = path.join(REPORTS, `external-alignment-${VERSION}${dry ? '-plan' : ''}.json`)
  if (merge && fs.existsSync(reportFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
      for (const [bid, b] of Object.entries(prev.benchmarks || {})) {
        if (!ids.includes(bid)) report.benchmarks[bid] = b
      }
      report.notes.push(`本次为合并模式：${Object.keys(report.benchmarks).join('、')} 为历史结果，其余为重跑结果`)
      console.log(`合并模式：保留 ${Object.keys(report.benchmarks).length} 个历史基准结果`)
    } catch (e) {
      console.log(`合并失败（将全量重写）：${e.message}`)
    }
  }

  for (const id of ids) {
    const ad = loadAdapter(id)
    if (!ad) { console.log(`\n### ${id}: 适配器尚未实现，跳过`); continue }
    const meta = S.BENCHMARKS[id] || {}
    console.log(`\n### ${ad.title} —— ${ad.layer}`)
    const plan = await ad.plan({ seed, sizes: sizes[id] || {}, log: (m) => console.log(m) })
    for (const n of plan.notes || []) console.log(`  · ${n}`)
    const sampleInfo = plan.sample
    console.log(`  抽样: ${JSON.stringify(Object.fromEntries(Object.entries(sampleInfo).map(([k, v]) => [k, { picked: v.picked, hash: (v.hash || '').slice(0, 12) }])))}`)
    if (dry) {
      report.benchmarks[id] = { title: ad.title, layer: ad.layer, source: ad.source, sample: sampleInfo, notes: plan.notes, dryRun: true, tasks: plan.tasks.length }
      continue
    }

    // 有的基准能在"不调用模型"的前提下先检验判分器本身（FinanceBench 有论文公开标签）
    let graderValidation = null
    if (typeof ad.validateGrader === 'function') {
      console.log('  · 先用论文公开结果验证判分器（不消耗模型调用）')
      try {
        graderValidation = await ad.validateGrader({ log: (m) => console.log(m) })
      } catch (e) {
        graderValidation = [{ error: String(e.message).slice(0, 200) }]
        console.log(`    判分器验证失败：${e.message}`)
      }
    }
    if (validateOnly) {
      report.benchmarks[id] = { title: ad.title, layer: ad.layer, source: ad.source, sample: sampleInfo, notes: plan.notes, graderValidation, validateOnly: true }
      continue
    }

    const runModels = ad.requiresVision ? models.filter((m) => VISION_MODELS.includes(m)) : models
    if (ad.requiresVision) {
      const skipped = models.filter((m) => !VISION_MODELS.includes(m))
      if (skipped.length) console.log(`  · 跳过 ${skipped.join(', ')}：实测不支持图像输入（见 probe8 证据）`)
    }

    const bench = { title: ad.title, layer: ad.layer, source: ad.source, sample: sampleInfo, notes: plan.notes, graderValidation, runs: {} }
    for (const model of runModels) {
      const client = new ModelClient({ model })
      const t0 = Date.now()
      process.stdout.write(`  [${model}] 运行中…\n`)
      let out
      try {
        out = await ad.run({
          tasks: plan.tasks,
          client,
          candidateModel: model,
          fbVariant: arg('--fb-variant', 'A0'),
          judgeVotes: Number(arg('--judge-votes', 1)),
          concurrency,
          log: (m) => console.log(m),
          getClient: (m) => new ModelClient({ model: m }),
          models: runModels,
        })
      } catch (e) {
        console.log(`  [${model}] ❌ 运行失败: ${e.message}`)
        bench.runs[model] = { error: String(e.message).slice(0, 500) }
        continue
      }
      const secs = Number(((Date.now() - t0) / 1000).toFixed(1))
      const detailFile = path.join(outDir, `${id}.${model}.json`)
      fs.writeFileSync(detailFile, JSON.stringify({ benchmark: id, model, metrics: out.metrics, rows: out.rows }, null, 2))
      bench.runs[model] = {
        metrics: out.metrics,
        seconds: secs,
        rows: out.rows.length,
        detail: path.relative(path.join(__dirname, '..', '..'), detailFile).replace(/\\/g, '/'),
        usage: client.describe(),
        // 适配器另起的 client（例如 FinanceBench 的裁判）用量单独记，避免成本被低估
        auxUsage: out.auxUsage || [],
      }
      console.log(`  [${model}] ✅ ${secs}s，${out.rows.length} 题，明细 → ${bench.runs[model].detail}`)
      printMetrics(out.metrics)
    }
    report.benchmarks[id] = bench
  }

  // 用量汇总：由报告里当前实际包含的基准求和得出（而不是累加历史），
  // 这样 --merge 局部重跑后总额自然一致，不会重复计数。
  const usageTotals = {}
  for (const b of Object.values(report.benchmarks)) {
    for (const run of Object.values(b.runs || {})) {
      if (!run || run.error || !run.usage) continue
      usageTotals[run.usage.model] = mergeUsage(usageTotals[run.usage.model], run.usage)
      for (const aux of run.auxUsage || []) {
        const key = `${aux.model}（${aux.role || '辅助'}调用）`
        usageTotals[key] = mergeUsage(usageTotals[key], aux)
      }
    }
  }
  report.modelUsage = usageTotals

  fs.mkdirSync(REPORTS, { recursive: true })
  const jsonFile = path.join(REPORTS, `external-alignment-${VERSION}${dry ? '-plan' : ''}.json`)
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2))
  const md = renderMarkdown(report)
  const mdFile = path.join(REPORTS, `external-alignment-${VERSION}${dry ? '-plan' : ''}.md`)
  fs.writeFileSync(mdFile, md)
  console.log(`\n聚合产物 → ${path.relative(process.cwd(), jsonFile)}`)
  console.log(`人读报告 → ${path.relative(process.cwd(), mdFile)}`)
  if (report.modelUsage && Object.keys(report.modelUsage).length) {
    console.log('\n=== 本次调用记账 ===')
    for (const [m, u] of Object.entries(report.modelUsage)) {
      console.log(`  ${m}: ${u.calls} 次调用（失败 ${u.failed}），in=${u.promptTokens} out=${u.completionTokens}（含推理 ${u.reasoningTokens || 0}），估算 ¥${u.estimatedCostCNY}`)
    }
  }

  // 供 bench/run.js 解析的机器可读汇总行；同时用它决定退出码——"一个基准都没跑成"必须算失败
  const summary = {
    version: VERSION,
    profile,
    seed,
    models,
    benchmarks: {},
    usage: report.modelUsage,
  }
  let emptyBenchmarks = 0
  for (const [id, b] of Object.entries(report.benchmarks)) {
    const runs = {}
    for (const [m, r] of Object.entries(b.runs || {})) {
      if (r.error) { runs[m] = { error: r.error.slice(0, 120) }; continue }
      runs[m] = { headline: collectNumbers(r.metrics).slice(0, 8), rows: r.rows, seconds: r.seconds }
    }
    const okRuns = Object.values(runs).filter((x) => !x.error).length
    if (!b.dryRun && !b.validateOnly && okRuns === 0) emptyBenchmarks++
    summary.benchmarks[id] = {
      title: b.title,
      layer: b.layer,
      sample: Object.fromEntries(Object.entries(b.sample || {}).map(([k, v]) => [k, { available: v.available, picked: v.picked, hash: String(v.hash || '').slice(0, 12) }])),
      runs,
      coverage: (b.sample && b.sample.coverage) || undefined,
      graderValidation: b.graderValidation ? b.graderValidation.map((g) => ({ label: g.label, publishedAccuracyPct: g.publishedAccuracyPct, deterministicAgreementPct: g.deterministicAgreementPct })) : undefined,
    }
  }
  if (!dry) console.log(`\nEXTERNAL-ALIGNMENT: ${JSON.stringify(summary)}`)
  if (emptyBenchmarks > 0) {
    console.error(`\n有 ${emptyBenchmarks} 个基准没有任何成功样本，按失败处理`)
    process.exitCode = 1
  }
}

function mergeUsage(a, b) {
  if (!a) return { ...b }
  for (const k of ['calls', 'failed', 'promptTokens', 'completionTokens', 'cacheHitTokens']) a[k] = (a[k] || 0) + (b[k] || 0)
  a.estimatedCostCNY = Number(((a.estimatedCostCNY || 0) + (b.estimatedCostCNY || 0)).toFixed(4))
  return a
}

/** 收集指标里的"数字型结论"，供控制台与机器可读汇总行共用 */
function collectNumbers(m) {
  const flat = []
  const walk = (o, p) => {
    if (o === null || o === undefined || typeof o !== 'object' || flat.length > 40) return
    if ('accuracyPct' in o && 'n' in o) { flat.push({ path: p, value: o.accuracyPct, n: o.n, kind: 'accuracy' }); return }
    if ('passRatePct' in o) { flat.push({ path: p, value: o.passRatePct, n: o.n, kind: 'passRate' }); return }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && /^mean/.test(k)) { flat.push({ path: `${p}.${k}`, value: v, kind: 'mean' }); continue }
      if (typeof v === 'number' && /RatePct$/.test(k)) { flat.push({ path: `${p}.${k}`, value: v, kind: 'pct' }); continue }
      walk(v, p ? `${p}.${k}` : k)
    }
  }
  walk(m, '')
  return flat
}

/** 控制台只打"一眼能看懂"的数字 */
function printMetrics(m) {
  for (const x of collectNumbers(m).slice(0, 14)) {
    const suffix = x.kind === 'accuracy' || x.kind === 'pct' ? '%' : ''
    console.log(`      ${x.path}: ${x.value}${suffix}${x.n ? ` (n=${x.n})` : ''}`)
  }
}

function renderMarkdown(report) {
  const L = []
  L.push(`# 外部基准对齐 · ${report.version}`)
  L.push('')
  L.push(`- 生成时间：${report.generatedAt}`)
  L.push(`- 抽样档位：${report.profile}；随机种子：${report.seed}；并发：${report.concurrency}`)
  L.push(`- 被测模型：${report.models.join('、')}`)
  L.push('')
  L.push('> 本文件由 `bench/external/run.js` 自动生成，数字全部来自评测产物；口径与局限见 `bench/external/README.md`。')
  L.push('')
  for (const [id, b] of Object.entries(report.benchmarks)) {
    L.push(`## ${b.title || id}${b.dryRun ? '（仅抽样）' : ''}`)
    L.push('')
    if (b.layer) L.push(`- 对应平台层级：${b.layer}`)
    if (b.source) L.push(`- 来源：${b.source.repo}@${b.source.ref}${b.source.paper ? ` · [论文](${b.source.paper})` : ''}`)
    if (b.sample) {
      const sampling = {}
      const extra = {}
      for (const [k, v] of Object.entries(b.sample)) {
        if (v && typeof v === 'object' && 'picked' in v) sampling[k] = { available: v.available, picked: v.picked, hash: String(v.hash || '').slice(0, 12) }
        else extra[k] = v
      }
      L.push(`- 抽样：${JSON.stringify(sampling)}`)
      if (Object.keys(extra).length) L.push(`- 分布：${JSON.stringify(extra)}`)
    }
    for (const n of b.notes || []) L.push(`- 说明：${n}`)
    L.push('')
    if (b.dryRun) { L.push(`题量 ${b.tasks}`); L.push(''); continue }
    L.push('| 模型 | 关键指标 | 用时(s) |')
    L.push('|---|---|---:|')
    for (const [model, r] of Object.entries(b.runs || {})) {
      if (r.error) { L.push(`| ${model} | 运行失败：${r.error.slice(0, 80)} | - |`); continue }
      const acc = []
      const walk = (o, p) => {
        if (!o || typeof o !== 'object' || acc.length > 6) return
        if ('accuracyPct' in o && 'n' in o) { acc.push(`${p}=${o.accuracyPct}%(n=${o.n})`); return }
        for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k)
      }
      walk(r.metrics, '')
      L.push(`| ${model} | ${acc.join('; ') || '-'} | ${r.seconds} |`)
    }
    L.push('')
  }
  return L.join('\n')
}

main().catch((e) => { console.error(e); process.exit(1) })

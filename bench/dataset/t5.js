#!/usr/bin/env node
/**
 * bench/dataset/t5.js —— T5「风险预警」层打分器（v0.1）
 *
 * 目标（可切换，见 labels.js 的 TARGETS）：
 *   在时间点 T，用**当时可得**的数据预测「未来 12 个月内是否发生风险事件」。
 *
 * 关键设计（不这样做，指标就是假的）：
 *   1. **point-in-time**：特征只用 `noticeDate ≤ T`（披露日期，不是报告期）的财报，
 *      标签只用 `T < event.date ≤ T+12m` 的事件 —— 严禁把未来信息喂给模型；
 *   2. **按时间切分**：训练/测试按年份切（不是随机切），模拟"用历史预测未来"；
 *   3. **病例-对照 + 基础率校正**：队列里 ST 被过采样，报告里同时给出原始与重加权指标；
 *   4. **预测器可插拔**：v0.1 内置"财务困境基线"（透明、可复算），
 *      平台自身的评分通过 replay 接入（下一步），两者用同一套指标对比。
 *
 * 指标：ROC-AUC、PR-AUC（平均精度）、Top-K 精确率、召回@K、提前预警期中位数（天）。
 *
 * 用法：
 *   node bench/dataset/t5.js --data bench/dataset/out [--target risk_warning_next_year]
 */
const fs = require('node:fs')
const path = require('node:path')

const { TARGETS } = require('./labels')

const argv = process.argv.slice(2)
const argOf = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const REPO = path.resolve(__dirname, '..', '..')
const DATA = path.resolve(REPO, argOf('--data', 'bench/dataset/out'))
const TARGET_NAME = argOf('--target', 'risk_warning_next_year')
const HORIZON_DAYS = Number(argOf('--horizon', '365'))
const TRAIN_UNTIL = argOf('--train-until', '2023-12-31')
const TEST_FROM = argOf('--test-from', '2024-01-01')
const CUTOFFS = argOf('--cutoffs', '2017-04-30,2018-04-30,2019-04-30,2020-04-30,2021-04-30,2022-04-30,2023-04-30,2024-04-30')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const readJsonl = (f) => {
  const p = path.join(DATA, f)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// ---------------------------------------------------------------- 指标
function rocAuc(pairs) {
  // pairs: [{score, label}]，按 score 排序后用 rank 法（含并列取平均秩）
  const pos = pairs.filter((p) => p.label === 1).length
  const neg = pairs.length - pos
  if (!pos || !neg) return null
  const sorted = [...pairs].sort((a, b) => a.score - b.score)
  let rank = 1
  let i = 0
  let sumPosRanks = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++
    const avgRank = (rank + (rank + (j - i))) / 2
    for (let k = i; k <= j; k++) if (sorted[k].label === 1) sumPosRanks += avgRank
    rank += j - i + 1
    i = j + 1
  }
  return (sumPosRanks - (pos * (pos + 1)) / 2) / (pos * neg)
}

function prAuc(pairs) {
  const sorted = [...pairs].sort((a, b) => b.score - a.score)
  const totalPos = sorted.filter((p) => p.label === 1).length
  if (!totalPos) return null
  let tp = 0
  let fp = 0
  let prevRecall = 0
  let ap = 0
  for (const p of sorted) {
    if (p.label === 1) tp++
    else fp++
    const recall = tp / totalPos
    const precision = tp / (tp + fp)
    ap += precision * (recall - prevRecall)
    prevRecall = recall
  }
  return ap
}

function topK(pairs, k) {
  const sorted = [...pairs].sort((a, b) => b.score - a.score)
  const slice = sorted.slice(0, k)
  const hits = slice.filter((p) => p.label === 1).length
  const totalPos = sorted.filter((p) => p.label === 1).length
  return { k, precision: slice.length ? hits / slice.length : null, recall: totalPos ? hits / totalPos : null, hits, totalPos }
}

// ---------------------------------------------------------------- 特征（point-in-time）
const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const safeDiv = (a, b) => (a === null || b === null || b === 0 ? null : a / b)

/** 取 cutoff 之前最后一次已披露的财报（严格用 noticeDate/报告期 ≤ cutoff） */
function lastDisclosedBefore(rows, cutoff) {
  const usable = rows.filter((r) => {
    const d = r.noticeDate || r.reportDate
    return d && d <= cutoff
  })
  if (!usable.length) return null
  usable.sort((a, b) => ((a.noticeDate || a.reportDate) < (b.noticeDate || b.reportDate) ? 1 : -1))
  return usable[0]
}

function featuresAt(row, prev) {
  if (!row) return null
  const assets = toNum(row.total_assets)
  const liab = toNum(row.total_liabilities)
  const equity = toNum(row.equity)
  const ca = toNum(row.current_assets)
  const cl = toNum(row.current_liabilities)
  const rev = toNum(row.revenue)
  const np = toNum(row.net_profit)
  const inv = toNum(row.inventory)
  const ar = toNum(row.accounts_receivable)
  const f = {
    debt_ratio: safeDiv(liab, assets),
    current_ratio: safeDiv(ca, cl),
    net_margin: safeDiv(np, rev),
    roe: safeDiv(np, equity),
    asset_turnover: safeDiv(rev, assets),
    inventory_ratio: safeDiv(inv, assets),
    receivable_ratio: safeDiv(ar, assets),
    negative_equity: equity !== null && equity < 0 ? 1 : 0,
    loss_making: np !== null && np < 0 ? 1 : 0,
    revenue_growth: prev ? safeDiv(rev !== null && toNum(prev.revenue) ? rev - toNum(prev.revenue) : null, toNum(prev.revenue)) : null,
  }
  return f
}

/** v0.1 基线预测器：财务困境规则分（透明、可复算、无训练） —— 作为"平台必须超过"的下限 */
function baselineScore(f) {
  if (!f) return null
  let s = 0
  const add = (cond, w) => {
    if (cond) s += w
  }
  add(f.debt_ratio !== null && f.debt_ratio > 0.7, 2.0)
  add(f.debt_ratio !== null && f.debt_ratio > 0.85, 1.0)
  add(f.negative_equity === 1, 3.0)
  add(f.loss_making === 1, 2.0)
  add(f.current_ratio !== null && f.current_ratio < 1, 1.5)
  add(f.revenue_growth !== null && f.revenue_growth < -0.3, 1.0)
  add(f.net_margin !== null && f.net_margin < -0.1, 1.0)
  add(f.roe !== null && f.roe < -0.1, 0.5)
  add(f.receivable_ratio !== null && f.receivable_ratio > 0.3, 0.5)
  add(f.inventory_ratio !== null && f.inventory_ratio > 0.4, 0.5)
  return s
}

// ---------------------------------------------------------------- 样本构造
function buildSamples({ panel, events, target, cutoffs, horizonDays }) {
  const byCode = new Map()
  for (const r of panel) {
    if (!byCode.has(r.code)) byCode.set(r.code, [])
    byCode.get(r.code).push(r)
  }
  const targetTypes = new Set(target.types || [])
  const targetSeverity = target.severity || null
  const eventsByCode = new Map()
  for (const e of events) {
    const hitType = targetTypes.size ? targetTypes.has(e.type) : targetSeverity ? e.severity === targetSeverity : true
    if (!hitType) continue
    if (!eventsByCode.has(e.code)) eventsByCode.set(e.code, [])
    eventsByCode.get(e.code).push(e)
  }

  const samples = []
  const skipped = { noFinance: 0, noFeatures: 0 }
  for (const [code, rows] of byCode) {
    for (const cutoff of cutoffs) {
      const row = lastDisclosedBefore(rows, cutoff)
      if (!row) {
        skipped.noFinance++
        continue
      }
      const prevRow = lastDisclosedBefore(
        rows.filter((r) => (r.noticeDate || r.reportDate) < (row.noticeDate || row.reportDate)),
        cutoff,
      )
      const f = featuresAt(row, prevRow)
      if (!f) {
        skipped.noFeatures++
        continue
      }
      const from = cutoff
      const to = new Date(new Date(cutoff).getTime() + horizonDays * 86400000).toISOString().slice(0, 10)
      const evs = (eventsByCode.get(code) || []).filter((e) => e.date > from && e.date <= to)
      const lead = evs.length
        ? Math.round((new Date(evs.map((e) => e.date).sort()[0]).getTime() - new Date(cutoff).getTime()) / 86400000)
        : null
      samples.push({
        code,
        name: row.name,
        cutoff,
        label: evs.length ? 1 : 0,
        firstEventDate: evs.length ? evs.map((e) => e.date).sort()[0] : null,
        firstEventType: evs.length ? evs.sort((a, b) => (a.date < b.date ? -1 : 1))[0].type : null,
        leadDays: lead,
        features: f,
        baseline: baselineScore(f),
        asOf: row.noticeDate || row.reportDate,
      })
    }
  }
  return { samples, skipped }
}

// ---------------------------------------------------------------- 主流程
const fmt = (v, d = 3) => (v === null || v === undefined ? '-' : Number(v).toFixed(d))

;(async () => {
  const panel = readJsonl('panel.jsonl')
  const events = readJsonl('events.jsonl')
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'))
  const target = TARGETS[TARGET_NAME]
  if (!target) {
    console.error(`未知目标：${TARGET_NAME}（可选：${Object.keys(TARGETS).join(', ')}）`)
    process.exit(2)
  }
  if (!panel.length || !events.length) {
    console.error(`数据不足：panel=${panel.length} events=${events.length}（先跑 fetch.js）`)
    process.exit(2)
  }

  console.log(`=== T5 风险预警层评测（目标：${target.label}）===`)
  console.log(`数据：panel ${panel.length} 条 / events ${events.length} 条 / 采集于 ${manifest.generatedAt}`)

  const { samples, skipped } = buildSamples({ panel, events, target, cutoffs: CUTOFFS, horizonDays: HORIZON_DAYS })
  const withScore = samples.filter((s) => typeof s.baseline === 'number')
  const train = withScore.filter((s) => s.cutoff <= TRAIN_UNTIL)
  const test = withScore.filter((s) => s.cutoff >= TEST_FROM)
  const posAll = withScore.filter((s) => s.label === 1).length
  console.log(`样本：${withScore.length} 个（病例-时点）| 正例 ${posAll}（${fmt((posAll / Math.max(withScore.length, 1)) * 100, 1)}%）| 跳过 ${JSON.stringify(skipped)}`)
  console.log(`切分：训练 ${train.length}（≤${TRAIN_UNTIL}）/ 测试 ${test.length}（≥${TEST_FROM}）`)

  const pairs = test.map((s) => ({ score: s.baseline, label: s.label, leadDays: s.leadDays }))
  const auc = rocAuc(pairs)
  const ap = prAuc(pairs)
  const k = Math.max(1, Math.round(test.length * 0.1))
  const tk = topK(pairs, k)
  const leads = test.filter((s) => s.label === 1 && typeof s.leadDays === 'number').map((s) => s.leadDays).sort((a, b) => a - b)
  const medianLead = leads.length ? leads[Math.floor(leads.length / 2)] : null
  const testPos = test.filter((s) => s.label === 1).length
  const baseRate = test.length ? testPos / test.length : null

  const byType = {}
  for (const s of test.filter((x) => x.label === 1)) byType[s.firstEventType] = (byType[s.firstEventType] || 0) + 1

  console.log('\n测试集指标（基线预测器：财务困境规则分）')
  console.log(`  ROC-AUC          ${fmt(auc)}`)
  console.log(`  PR-AUC(AP)       ${fmt(ap)}   （随机基线 ≈ 正例率 ${fmt(baseRate)}）`)
  console.log(`  Top-${k} 精确率    ${fmt(tk.precision)}（命中 ${tk.hits}/${k}）  召回 ${fmt(tk.recall)}`)
  console.log(`  提前预警期中位数  ${medianLead === null ? '-' : medianLead + ' 天'}`)
  console.log(`  测试集正例构成    ${JSON.stringify(byType)}`)

  const out = {
    generatedAt: new Date().toISOString(),
    target: TARGET_NAME,
    targetLabel: target.label,
    data: { panel: panel.length, events: events.length, collectedAt: manifest.generatedAt },
    cutoffs: CUTOFFS,
    horizonDays: HORIZON_DAYS,
    split: { trainUntil: TRAIN_UNTIL, testFrom: TEST_FROM, train: train.length, test: test.length },
    samples: withScore.length,
    positiveRate: withScore.length ? posAll / withScore.length : null,
    skipped,
    metrics: {
      predictor: 'baseline:financial-distress-rule',
      rocAuc: auc,
      prAuc: ap,
      topK: tk,
      medianLeadDays: medianLead,
      testBaseRate: baseRate,
      testPositiveByType: byType,
    },
    examples: {
      topScored: [...test].sort((a, b) => b.baseline - a.baseline).slice(0, 10).map((s) => ({ code: s.code, name: s.name, cutoff: s.cutoff, score: s.baseline, label: s.label, event: s.firstEventType, leadDays: s.leadDays })),
      missedHighRisk: test.filter((s) => s.label === 1).sort((a, b) => a.baseline - b.baseline).slice(0, 10).map((s) => ({ code: s.code, name: s.name, cutoff: s.cutoff, score: s.baseline, event: s.firstEventType, leadDays: s.leadDays, features: s.features })),
    },
  }
  fs.writeFileSync(path.join(DATA, 't5-report.json'), JSON.stringify(out, null, 2))
  console.log(`\n报告：${path.relative(REPO, path.join(DATA, 't5-report.json'))}`)
  console.log(
    `T5: ${JSON.stringify({ target: TARGET_NAME, samples: out.samples, test: test.length, auc, ap, topk_precision: tk.precision, median_lead_days: medianLead })}`,
  )
})()

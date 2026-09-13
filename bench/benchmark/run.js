#!/usr/bin/env node
/**
 * bench/benchmark/run.js —— FinRisk-Bench v0.1（自动判定层：T1 / T3 / T4）
 *
 * 这是**能力基准**，不是回归测试：样本由已知生成过程造出来（真值精确已知），
 * 用它度量平台"读得准不准、能不能发现错、算得对不对"。
 *
 *   T1 结构化抽取：宽表文本 → 平台导入 → 逐格比对真值（字段级 P/R/F1、MAPE、完全命中率）
 *   T3 勾稽校验：注入 4 类已知缺陷（不平/缺权益/比率不一致/缺期间）→ 期望校验指出对应问题码
 *                （按类召回率 + 干净样本上的误报率）
 *   T4 指标正确性：把已知样本入库 → 与"独立重算"的 KPI 比对（资产负债率/毛利率/净利率/ROE/流动比率）
 *
 * 用法：
 *   node bench/benchmark/run.js --port 8265 [--cases 12] [--seed 20260913]
 *   （在 bench/run.js 里作为套件 finrisk-bench 自动执行，端口由框架注入）
 */
const fs = require('node:fs')
const path = require('node:path')

const { generateCases, pctText, prf, relError, renderCase, renderVariant } = require('./lib')

const argv = process.argv.slice(2)
const argOf = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const REPO = path.resolve(__dirname, '..', '..')
const PORT = Number(argOf('--port', '0')) || Number(process.env.BENCH_PORT || 0)
const CASES = Number(argOf('--cases', '12')) || 12
const SEED = Number(argOf('--seed', '20260913')) || 20260913
const OUT_DIR = path.resolve(REPO, argOf('--out', 'bench/report'))

if (!PORT) {
  console.error('缺少 --port（后端端口）')
  process.exit(2)
}

const BASE = `http://127.0.0.1:${PORT}`

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把文档里的 (field, year) → 值 抽出来，便于与真值比对 */
function extractObserved(doc) {
  const observed = {}
  const cols = doc?.sheet?.columns || []
  const rows = doc?.sheet?.rows || []
  for (const row of rows) {
    const field = row.field || ''
    if (!field) continue
    for (const col of cols) {
      const period = String(col.period || '').trim()
      if (!/^\d{4}$/.test(period)) continue
      const cell = (row.cells || {})[col.key]
      if (!cell || cell.value === null || cell.value === undefined) continue
      const year = Number(period)
      observed[field] = observed[field] || {}
      observed[field][year] = Number(cell.value)
    }
  }
  return observed
}

async function importText(text, title) {
  return req('POST', '/api/tables/import', { text, title, unit: '万元', scope: '合并报表' })
}

async function delTable(id) {
  try {
    await req('DELETE', `/api/tables/${id}`)
  } catch {}
}

// ---------------------------------------------------------------- T1
async function runT1(cases) {
  const detail = []
  let tp = 0
  let fp = 0
  let fn = 0
  let exact = 0
  let total = 0
  const relErrors = []

  for (const c of cases) {
    const text = renderCase(c, { style: c.style, withUnitLine: c.withUnitLine, withTitleRow: c.withTitleRow })
    const imp = await importText(text, `FinRiskBench T1 ${c.id}`)
    if (imp.status !== 200 || !imp.json?.table_id) {
      detail.push({ id: c.id, ok: false, error: `import ${imp.status} ${String(imp.text).slice(0, 120)}` })
      continue
    }
    const tid = imp.json.table_id
    const doc = await req('GET', `/api/tables/${tid}`)
    const observed = extractObserved(doc.json)
    await delTable(tid)

    let caseTp = 0
    let caseFp = 0
    let caseFn = 0
    const mismatches = []
    for (const [field, years] of Object.entries(c.truth)) {      for (const [yearStr, want] of Object.entries(years)) {
        const year = Number(yearStr)
        total++
        const got = observed[field]?.[year]
        if (got === undefined) {
          caseFn++
          mismatches.push(`${field}@${year} 缺失`)
          continue
        }
        const err = relError(got, want)
        relErrors.push(err)
        if (err !== null && err <= 0.0005) {
          caseTp++
          if (Math.abs(got - want) < 1e-9) exact++
        } else {
          caseFp++
          caseFn++
          mismatches.push(`${field}@${year} got=${got} want=${want}`)
        }
      }
    }
    // 平台多读出来的字段（真值里没有）也算误报
    for (const [field, years] of Object.entries(observed)) {
      if (c.truth[field]) continue
      caseFp += Object.keys(years).length
    }
    tp += caseTp
    fp += caseFp
    fn += caseFn
    detail.push({ id: c.id, ok: caseFn === 0 && caseFp === 0, tp: caseTp, fp: caseFp, fn: caseFn, mismatches: mismatches.slice(0, 4) })
  }

  const finiteErrors = relErrors.filter((e) => typeof e === 'number' && Number.isFinite(e))
  const mape = finiteErrors.length ? finiteErrors.reduce((a, b) => a + b, 0) / finiteErrors.length : null
  return {
    layer: 'T1 结构化抽取',
    metrics: {
      ...prf(tp, fp, fn),
      cells: total,
      exactMatchRate: total ? exact / total : null,
      mape,
      tolerancePct: 0.05,
    },
    detail,
  }
}

// ---------------------------------------------------------------- T3
async function runT3(cleanCases, variants, enterpriseId) {
  const perCode = {}
  const detail = []
  let cleanFp = 0
  let cleanChecked = 0
  // 与数据质量无关的"前置条件"类问题码（未绑企业等）不算数据缺陷的误报
  const PREREQ_CODES = new Set(['NO_ENTERPRISE'])

  const check = async (label, text, expectedCodes, kind, expectImportRejected = false) => {
    const imp = await importText(text, `FinRiskBench T3 ${label}`)
    if (imp.status !== 200 || !imp.json?.table_id) {
      // 「缺期间」这类样本，正确行为是导入阶段就拒绝并给出可读提示
      const msg = String(imp.json?.detail || imp.text || '')
      if (expectImportRejected && imp.status === 400 && /未(能)?识别|期间|年份/.test(msg)) {
        for (const want of expectedCodes) {
          perCode[want] = perCode[want] || { tp: 0, fn: 0, fp: 0 }
          perCode[want].tp++
        }
        detail.push({ id: label, kind, ok: true, rejectedAtImport: true, message: msg.slice(0, 80) })
        return
      }
      detail.push({ id: label, kind, ok: false, error: `import ${imp.status} ${String(imp.text).slice(0, 120)}` })
      return
    }
    const tid = imp.json.table_id
    if (enterpriseId) await req('PATCH', `/api/tables/${tid}`, { enterprise_id: enterpriseId })
    const val = await req('POST', `/api/tables/${tid}/validate`, {})
    const issues = val.json?.issues || []
    const codes = [...new Set(issues.map((i) => i.code))]
    await delTable(tid)

    if (kind === 'clean') {
      cleanChecked++
      const errs = issues.filter((i) => i.level === 'error' && !PREREQ_CODES.has(i.code)).map((i) => i.code)
      if (errs.length) cleanFp++
      detail.push({ id: label, kind, ok: errs.length === 0, codes, errs })
      return
    }

    // 「必须被拦住」型缺陷（如缺期间）：拦在导入阶段或校验阶段、用哪个码都算拦住，
    // 但把实际码记下来——口径不一致本身就是值得记录的现象。
    if (expectedCodes.includes('NO_PERIOD')) {
      const errs = issues.filter((i) => i.level === 'error' && !PREREQ_CODES.has(i.code)).map((i) => i.code)
      perCode.NO_PERIOD = perCode.NO_PERIOD || { tp: 0, fn: 0, fp: 0 }
      if (errs.length) perCode.NO_PERIOD.tp++
      else perCode.NO_PERIOD.fn++
      detail.push({ id: label, kind, ok: errs.length > 0, blockedBy: errs, expect: '任意错误级拦截' })
      return
    }

    for (const want of expectedCodes) {
      perCode[want] = perCode[want] || { tp: 0, fn: 0, fp: 0 }
      if (codes.includes(want)) perCode[want].tp++
      else perCode[want].fn++
    }
    // 变体上出现"非该变体预期"的错误码 → 记为误报（归到那个码上）
    for (const c of codes) {
      if (expectedCodes.includes(c)) continue
      perCode[c] = perCode[c] || { tp: 0, fn: 0, fp: 0 }
      perCode[c].fp++
    }
    detail.push({ id: label, kind, ok: expectedCodes.every((c) => codes.includes(c)), expect: expectedCodes, codes })
  }

  for (const c of cleanCases) {
    await check(c.id, renderCase(c, { style: c.style, withUnitLine: c.withUnitLine, withTitleRow: c.withTitleRow }), [], 'clean')
  }
  for (const v of variants) {
    await check(v.id, renderVariant(v, 'plain'), v.expectCodes, 'variant', !!v.expectImportRejected)
  }

  const codes = {}
  let tp = 0
  let fn = 0
  let fp = 0
  for (const [code, v] of Object.entries(perCode)) {
    codes[code] = { ...prf(v.tp, v.fp, v.fn) }
    tp += v.tp
    fn += v.fn
    fp += v.fp
  }
  return {
    layer: 'T3 勾稽校验',
    metrics: {
      ...prf(tp, fp, fn),
      perCodeRecall: Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, v.recall])),
      cleanFalsePositiveRate: cleanChecked ? cleanFp / cleanChecked : null,
      cleanChecked,
    },
    detail,
  }
}

// ---------------------------------------------------------------- T4
async function runT4(cases, enterpriseId, maxCases = 3) {
  if (!enterpriseId) {
    return { layer: 'T4 指标正确性', metrics: { skipped: true, reason: '没有可用企业' }, detail: [] }
  }

  const detail = []
  const usedYears = []
  const truth = {}
  let checked = 0
  let agreed = 0
  const worst = []

  for (const [i, c] of cases.slice(0, maxCases).entries()) {
    // 每条样本用各自独立的年份，避免互相覆盖；年份取 2081 起，远离真实财报年份，防止撞上公开数据被跳过
    const years = [2081 + i * 2, 2082 + i * 2]
    const shifted = JSON.parse(JSON.stringify(c))
    const remap = (obj) => Object.fromEntries(years.map((y, k) => [y, obj[c.years[k]]]))
    shifted.years = years
    shifted.rows = c.rows.map((r) => ({ ...r, values: remap(r.values) }))
    shifted.perYear = Object.fromEntries(years.map((y, k) => [y, c.perYear[c.years[k]]]))

    const text = renderCase(shifted, { style: 'plain', withUnitLine: true })
    const imp = await importText(text, `FinRiskBench T4 ${c.id}`)
    if (imp.status !== 200 || !imp.json?.table_id) continue
    const tid = imp.json.table_id
    await req('PATCH', `/api/tables/${tid}`, { enterprise_id: enterpriseId })
    const val = await req('POST', `/api/tables/${tid}/validate`, {})
    if (val.json?.ok !== true) {
      detail.push({ id: c.id, ok: false, error: `校验未通过：${(val.json?.issues || []).map((i) => i.code).join(',')}` })
      await delTable(tid)
      continue
    }
    const ing = await req('POST', `/api/tables/${tid}/ingest`, {})
    if (ing.status !== 200) {
      detail.push({ id: c.id, ok: false, error: `入库失败 ${ing.status} ${String(ing.text).slice(0, 120)}` })
      await delTable(tid)
      continue
    }
    await delTable(tid)
    usedYears.push(...years)
    for (const y of years) truth[y] = shifted.perYear[y]
  }

  if (!usedYears.length) {
    return { layer: 'T4 指标正确性', metrics: { skipped: true, reason: '没有样本成功入库' }, detail }
  }

  const fin = await req('GET', `/api/finance/${enterpriseId}/analysis`)
  // trends 是"分组对象"：{ group: { label, series: [{ key, points: [{year, value}] }] } }
  const trendsObj = fin.json?.trends || {}
  const observed = {}
  for (const group of Object.values(trendsObj)) {
    for (const item of group?.series || []) {
      for (const pt of item.points || []) {
        const y = Number(pt.year)
        if (!usedYears.includes(y)) continue
        observed[item.key] = observed[item.key] || {}
        observed[item.key][y] = pt.value
      }
    }
  }

  // 独立重算（不依赖平台代码：直接用真值按会计定义算）
  const expect = {
    net_margin: (p) => (100 * p.net_profit_total_wan) / p.revenue_wan,
    roe: (p) => (100 * p.net_profit_total_wan) / p.equity_wan,
    roa: (p) => (100 * p.net_profit_total_wan) / p.total_assets_wan,
    current_ratio: (p) => p.current_assets_wan / p.current_liabilities_wan,
    asset_turnover: (p) => p.revenue_wan / p.total_assets_wan,
    equity_multiplier: (p) => p.total_assets_wan / p.equity_wan,
  }
  // 资产负债率 / 毛利率只在 KPI 卡片里给"最新一期"，单独按年核对
  const kpiExpect = {
    debt_ratio: (p) => (100 * p.total_liabilities_wan) / p.total_assets_wan,
    gross_margin: (p) => (p.operating_cost_wan === undefined ? null : (100 * (p.revenue_wan - p.operating_cost_wan)) / p.revenue_wan),
  }

  const perKey = {}
  let missing = 0
  for (const y of usedYears) {
    const p = truth[y]
    if (!p) continue
    for (const [key, fn] of Object.entries(expect)) {
      const want = fn(p)
      if (want === null || !Number.isFinite(want)) continue
      const got = observed[key]?.[y]
      perKey[key] = perKey[key] || { checked: 0, agreed: 0, missing: 0, maxRel: 0 }
      if (typeof got !== 'number') {
        // 该年度没有出现在分析结果里（例如入库被"不覆盖公开数据"规则跳过）→ 单独计数，不算错
        missing++
        perKey[key].missing++
        continue
      }
      const rounded = Math.round(want * 10000) / 10000
      checked++
      perKey[key].checked++
      const err = relError(got, rounded)
      if (err !== null && err <= 0.005) {
        agreed++
        perKey[key].agreed++
      } else {
        worst.push(`${key}@${y} got=${got} want=${rounded}`)
      }
      if (err !== null && Number.isFinite(err)) perKey[key].maxRel = Math.max(perKey[key].maxRel, err)
    }
  }

  // KPI 卡片（只有最新一期）里的 debt_ratio / gross_margin 也核对一遍
  const kpiByKey = {}
  for (const item of fin.json?.kpi || []) kpiByKey[item.key] = item
  for (const [key, fn] of Object.entries(kpiExpect)) {
    const item = kpiByKey[key]
    const y = Number(item?.year)
    if (!item || !usedYears.includes(y)) continue
    const p = truth[y]
    if (!p) continue
    const want = fn(p)
    if (want === null || !Number.isFinite(want)) continue
    const rounded = Math.round(want * 10000) / 10000
    perKey[key] = perKey[key] || { checked: 0, agreed: 0, missing: 0, maxRel: 0 }
    if (typeof item.value !== 'number') {
      missing++
      perKey[key].missing++
      continue
    }
    checked++
    perKey[key].checked++
    const err = relError(item.value, rounded)
    if (err !== null && err <= 0.005) {
      agreed++
      perKey[key].agreed++
    } else {
      worst.push(`${key}@${y} got=${item.value} want=${rounded}`)
    }
    if (err !== null && Number.isFinite(err)) perKey[key].maxRel = Math.max(perKey[key].maxRel, err)
  }

  return {
    layer: 'T4 指标正确性',
    metrics: {
      checked,
      agreed,
      missing,
      agreementRate: checked ? agreed / checked : null,
      tolerancePct: 0.5,
      perKey: Object.fromEntries(
        Object.entries(perKey).map(([k, v]) => [k, { checked: v.checked, agreed: v.agreed, missing: v.missing, maxRelPct: Number((v.maxRel * 100).toFixed(3)) }]),
      ),
      years: usedYears,
    },
    detail: [{ ok: checked > 0 && agreed === checked, worst: worst.slice(0, 8) }],
  }
}

// ---------------------------------------------------------------- 主流程
function scoreboard(layers, meta) {
  const t1 = layers.find((l) => l.layer.startsWith('T1')).metrics
  const t3 = layers.find((l) => l.layer.startsWith('T3')).metrics
  const t4 = layers.find((l) => l.layer.startsWith('T4')).metrics
  const gates = [
    { name: 'T1 字段 F1 ≥ 0.98', ok: (t1.f1 ?? 0) >= 0.98, value: t1.f1 },
    { name: 'T1 完全命中率 ≥ 0.95', ok: (t1.exactMatchRate ?? 0) >= 0.95, value: t1.exactMatchRate },
    { name: 'T3 缺陷召回 ≥ 0.95', ok: (t3.recall ?? 0) >= 0.95, value: t3.recall },
    { name: 'T3 干净样本误报率 ≤ 0.05', ok: (t3.cleanFalsePositiveRate ?? 1) <= 0.05, value: t3.cleanFalsePositiveRate },
    { name: 'T4 指标一致率 ≥ 0.95', ok: t4.skipped ? false : (t4.agreementRate ?? 0) >= 0.95, value: t4.skipped ? null : t4.agreementRate },
  ]
  return { meta, layers, gates, passed: gates.every((g) => g.ok) }
}

function toMarkdown(board) {
  const L = []
  const t1 = board.layers.find((l) => l.layer.startsWith('T1')).metrics
  const t3 = board.layers.find((l) => l.layer.startsWith('T3')).metrics
  const t4 = board.layers.find((l) => l.layer.startsWith('T4')).metrics
  L.push('# FinRisk-Bench v0.1 · 企业经营风险预警平台能力基准')
  L.push('')
  L.push(`> 样本：${board.meta.count} 条干净财报 + ${board.meta.variantCount} 条注入缺陷 · 种子 ${board.meta.seed}（可复现）`)
  L.push('> 真值由生成过程直接给出，不依赖人工标注；打分与平台输出是两条独立路径。')
  L.push('')
  L.push('## T1 结构化抽取（宽表文本 → 平台导入 → 逐格比对）')
  L.push('')
  L.push('| 指标 | 值 |')
  L.push('|---|---:|')
  L.push(`| 单元格总数 | ${t1.cells} |`)
  L.push(`| 字段级 精确率 / 召回率 / F1 | ${pctText(t1.precision)} / ${pctText(t1.recall)} / **${pctText(t1.f1)}** |`)
  L.push(`| 完全命中率（误差 ≤ 0.05%） | ${pctText(t1.exactMatchRate)} |`)
  L.push(`| 平均相对误差 MAPE | ${t1.mape === null ? '-' : (t1.mape * 100).toFixed(4) + '%'} |`)
  L.push('')
  L.push('## T3 勾稽校验（注入已知缺陷，看能不能指出来）')
  L.push('')
  L.push('| 指标 | 值 |')
  L.push('|---|---:|')
  L.push(`| 缺陷召回率（按类微平均） | **${pctText(t3.recall)}** |`)
  L.push(`| 精确率 / F1 | ${pctText(t3.precision)} / ${pctText(t3.f1)} |`)
  L.push(`| 干净样本误报率 | ${pctText(t3.cleanFalsePositiveRate)}（${t3.cleanChecked} 条干净样本） |`)
  L.push('')
  L.push('| 问题码 | 召回率 |')
  L.push('|---|---:|')
  for (const [code, r] of Object.entries(t3.perCodeRecall)) L.push(`| \`${code}\` | ${pctText(r)} |`)
  L.push('')
  L.push('## T4 指标正确性（入库后与独立重算比对）')
  L.push('')
  if (t4.skipped) {
    L.push(`_跳过：${t4.reason}_`)
  } else {
    L.push(`核查 ${t4.checked} 个指标点，一致（相对误差 ≤ 0.5%）**${t4.agreed}** 个 → 一致率 **${pctText(t4.agreementRate)}**`)
    L.push('')
    L.push('| 指标 | 一致 / 核查 | 最大相对误差 |')
    L.push('|---|---:|---:|')
    for (const [k, v] of Object.entries(t4.perKey)) L.push(`| \`${k}\` | ${v.agreed}/${v.checked} | ${v.maxRelPct}% |`)
  }
  L.push('')
  L.push('## 门槛')
  L.push('')
  L.push('| 门槛 | 实测 | 结论 |')
  L.push('|---|---:|---|')
  for (const g of board.gates) L.push(`| ${g.name} | ${typeof g.value === 'number' ? pctText(g.value) : '-'} | ${g.ok ? '✅' : '❌'} |`)
  L.push('')
  L.push('## 说明与边界')
  L.push('')
  L.push('- v0.1 只做**自动判定层**（T1/T3/T4）。T2 图片读取、T5 风险标签、T6 Agent 工具链、T7 报告质量尚未纳入：')
  L.push('  T2/T6 需要真实模型与稳定的判定规则，T5 需要**真实风险事件标签**（属于数据管道工作，见 v1 方案 M3）。')
  L.push('- 样本是"合成的真实形状"：满足会计恒等式、带千分位/括号负数/全角空格/单位行等脏格式，')
  L.push('  但**不能替代真实上市公司财报**；接入真实数据后必须重跑并对比。')
  L.push('- 该基准测的是"读得准、能发现错、算得对"，**不测**"预警是否真有价值"——后者要靠 T5 与事后事件对齐。')
  return L.join('\n')
}

;(async () => {
  const health = await req('GET', '/api/health')
  if (health.status !== 200) {
    console.error('后端不可用：', health.status)
    process.exit(2)
  }
  const { clean, variants, meta } = generateCases({ count: CASES, seed: SEED })
  console.log(`FinRisk-Bench v0.1 · 样本 ${clean.length} 干净 + ${variants.length} 注入 · 种子 ${SEED}`)

  // 选一个"有财报数据"的企业作为 T3/T4 的绑定对象（T4 会往它写入合成年度）
  const ents = await req('GET', '/api/enterprises')
  const items = ents.json?.items || []
  let enterpriseId = items[0]?.id || null
  for (const it of items) {
    const fa = await req('GET', `/api/finance/${it.id}/analysis`)
    if (fa.json?.available === true) {
      enterpriseId = it.id
      break
    }
  }

  const t1 = await runT1(clean)
  console.log(`  T1 字段 F1=${pctText(t1.metrics.f1)} 完全命中=${pctText(t1.metrics.exactMatchRate)} MAPE=${t1.metrics.mape === null ? '-' : (t1.metrics.mape * 100).toFixed(4) + '%'}`)

  const t3 = await runT3(clean, variants, enterpriseId)
  console.log(`  T3 召回=${pctText(t3.metrics.recall)} 误报率=${pctText(t3.metrics.cleanFalsePositiveRate)}`)

  const t4 = await runT4(clean, enterpriseId)
  console.log(`  T4 指标一致率=${t4.metrics.skipped ? '跳过' : pctText(t4.metrics.agreementRate)}（核查 ${t4.metrics.checked ?? 0} 点）`)

  const board = scoreboard([t1, t3, t4], { ...meta, variantCount: variants.length })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const jsonFile = path.join(OUT_DIR, 'finrisk-bench.json')
  const mdFile = path.join(OUT_DIR, 'finrisk-bench.md')
  fs.writeFileSync(jsonFile, JSON.stringify(board, null, 2), 'utf8')
  fs.writeFileSync(mdFile, toMarkdown(board) + '\n', 'utf8')
  console.log(`  报告：${path.relative(REPO, mdFile)}`)
  console.log(
    `FINRISK: ${JSON.stringify({
      t1_f1: t1.metrics.f1,
      t1_exact: t1.metrics.exactMatchRate,
      t1_mape: t1.metrics.mape,
      t3_recall: t3.metrics.recall,
      t3_fpr: t3.metrics.cleanFalsePositiveRate,
      t4_agreement: t4.metrics.skipped ? null : t4.metrics.agreementRate,
      gates_passed: board.gates.filter((g) => g.ok).length,
      gates_total: board.gates.length,
    })}`,
  )
  console.log('ERRORS: []')
  process.exit(board.passed ? 0 : 1)
})().catch((err) => {
  console.log('FATAL:', String((err && err.stack) || err))
  console.log('ERRORS: ["benchmark crashed"]')
  process.exit(2)
})

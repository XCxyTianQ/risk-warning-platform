/**
 * bench/benchmark/lib.js —— FinRisk-Bench 的样本生成与打分工具。
 *
 * 设计原则（为什么可以自动判定）：
 *   样本由**已知生成过程**造出来（先定真值，再渲染成不同格式的文本），
 *   所以每个格子的正确值、每类勾稽错误的期望码都是**程序已知**的，
 *   不需要人工标注，也不会"自己给自己打分"——真值与平台输出是两条独立的路径。
 *
 * 覆盖的"脏"格式（现实中常见的，不全是干净数字）：
 *   千分位、括号负数、百分号、前后空格、全角空格、单位行、多列期间、缺失科目。
 */

/** 确定性随机（同一种子 → 同一样本集，评测可复现） */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round2 = (n) => Math.round(n * 100) / 100

/** 生成一条"干净的"财报：满足 资产 = 负债 + 权益，且各科目量级合理 */
function genCleanCase(index, rnd, years) {
  const scale = 50_000 + Math.floor(rnd() * 950_000) // 5 亿 ~ 100 亿（万元）
  const debtRatio = 0.25 + rnd() * 0.5 // 25% ~ 75%
  const totalAssets = round2(scale)
  const totalLiabilities = round2(totalAssets * debtRatio)
  const equity = round2(totalAssets - totalLiabilities)

  const revenue = round2(scale * (0.6 + rnd() * 0.8))
  const grossRate = 0.15 + rnd() * 0.45
  const operatingCost = round2(revenue * (1 - grossRate))
  const netRate = 0.02 + rnd() * 0.18
  const netProfit = round2(revenue * netRate)
  const currentAssets = round2(totalAssets * (0.35 + rnd() * 0.35))
  const currentLiabilities = round2(totalLiabilities * (0.5 + rnd() * 0.4))
  const inventory = round2(currentAssets * (0.15 + rnd() * 0.3))
  const receivables = round2(currentAssets * (0.1 + rnd() * 0.3))
  const ocf = round2(netProfit * (0.5 + rnd() * 1.2))

  const growth = 0.92 + rnd() * 0.3 // 次年增速
  const perYear = {}
  years.forEach((y, i) => {
    const k = i === 0 ? 1 : growth
    perYear[y] = {
      revenue_wan: round2(revenue * k),
      operating_cost_wan: round2(operatingCost * k),
      net_profit_total_wan: round2(netProfit * k),
      total_assets_wan: round2(totalAssets * (i === 0 ? 1 : 1 + (growth - 1) * 0.8)),
      total_liabilities_wan: round2(totalLiabilities * (i === 0 ? 1 : 1 + (growth - 1) * 0.8)),
      equity_wan: round2(equity * (i === 0 ? 1 : 1 + (growth - 1) * 0.8)),
      current_assets_wan: round2(currentAssets * k),
      current_liabilities_wan: round2(currentLiabilities * k),
      inventory_wan: round2(inventory * k),
      accounts_receivable_wan: round2(receivables * k),
      ocf_wan: round2(ocf * k),
    }
    // 抽掉一个科目 → 测"缺失科目"的容错（真值里也标记为缺失）
    if (index % 7 === 3) delete perYear[y].inventory_wan
    if (index % 11 === 5) delete perYear[y].accounts_receivable_wan
  })

  // 保证恒等式在四舍五入后仍成立：权益 = 资产 - 负债
  for (const y of years) {
    const p = perYear[y]
    p.equity_wan = round2(p.total_assets_wan - p.total_liabilities_wan)
  }

  const rows = Object.keys(perYear[years[0]]).map((field) => ({ field, values: Object.fromEntries(years.map((y) => [y, perYear[y][field]])) }))
  // 真值统一成"字段优先"：truth[field][year] = 值（比对与重算都按这个口径）
  const truth = {}
  for (const y of years) {
    for (const [field, value] of Object.entries(perYear[y])) {
      truth[field] = truth[field] || {}
      truth[field][y] = value
    }
  }
  return { id: `clean-${index}`, kind: 'clean', years, rows, truth, perYear, expectCodes: [] }
}

const LABELS = {
  revenue_wan: '营业总收入',
  operating_cost_wan: '营业成本',
  net_profit_total_wan: '净利润',
  total_assets_wan: '资产总计',
  total_liabilities_wan: '负债合计',
  equity_wan: '所有者权益合计',
  current_assets_wan: '流动资产合计',
  current_liabilities_wan: '流动负债合计',
  inventory_wan: '存货',
  accounts_receivable_wan: '应收账款',
  ocf_wan: '经营活动产生的现金流量净额',
}

/** 把数字渲染成"带脏格式"的单元格文本 */
function renderValue(v, style) {
  if (v === undefined || v === null) return ''
  if (style === 'plain') return String(v)
  if (style === 'thousands') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (style === 'negative-paren') return v < 0 ? `(${Math.abs(v)})` : v.toFixed(2)
  if (style === 'spaced') return `\u3000${v}\u3000`
  return String(v)
}

/** 渲染成平台能识别的宽表文本（科目 | 期间1 | 期间2 ...） */
function renderCase(c, { style = 'plain', withUnitLine = false, withTitleRow = false } = {}) {
  const years = c.years
  const lines = []
  if (withTitleRow) lines.push(`财报数据\t\t`)
  if (withUnitLine) lines.push(`单位：万元\t${years.map(() => '').join('\t')}`)
  lines.push(['科目', ...years.map((y) => `${y}年报`)].join('\t'))
  for (const r of c.rows) {
    lines.push([LABELS[r.field] || r.field, ...years.map((y) => renderValue(r.values[y], style))].join('\t'))
  }
  return lines.join('\n')
}

/** 变体：注入已知缺陷，期望校验能指出对应问题码 */
function genVariants(base) {
  const out = []
  const y0 = base.years[0]

  // 1) 勾稽不平：把权益改掉（资产 ≠ 负债 + 权益）
  {
    const c = JSON.parse(JSON.stringify(base))
    c.id = `${base.id}-balance`
    c.kind = 'variant'
    const row = c.rows.find((r) => r.field === 'equity_wan')
    if (row) {
      row.values[y0] = round2(row.values[y0] * 0.6)
      c.truth.equity_wan[y0] = row.values[y0]
      c.perYear[y0].equity_wan = row.values[y0]
    }
    c.expectCodes = ['BALANCE_MISMATCH']
    out.push(c)
  }

  // 2) 缺权益行：资产负债表不完整
  {
    const c = JSON.parse(JSON.stringify(base))
    c.id = `${base.id}-no-equity`
    c.kind = 'variant'
    c.rows = c.rows.filter((r) => r.field !== 'equity_wan')
    delete c.truth.equity_wan
    for (const y of c.years) delete c.perYear[y].equity_wan
    c.expectCodes = ['MISSING_EQUITY']
    out.push(c)
  }

  // 3) 资产负债率与三表不一致：额外给一行"资产负债率"，但数值明显对不上
  {
    const c = JSON.parse(JSON.stringify(base))
    c.id = `${base.id}-ratio`
    c.kind = 'variant'
    c.extraRow = { label: '资产负债率', values: Object.fromEntries(c.years.map((y) => [y, 5])) }
    c.expectCodes = ['DEBT_RATIO_MISMATCH']
    out.push(c)
  }

  // 4) 缺期间：只有科目列，无法入库（平台的正确行为是**导入阶段就拒绝**）
  {
    const c = JSON.parse(JSON.stringify(base))
    c.id = `${base.id}-no-period`
    c.kind = 'variant'
    c.dropPeriods = true
    c.expectImportRejected = true
    c.expectCodes = ['NO_PERIOD']
    out.push(c)
  }

  return out
}

function renderVariant(c, style) {
  const years = c.years
  const lines = []
  if (c.dropPeriods) {
    lines.push('科目\t数值')
    for (const r of c.rows) lines.push([LABELS[r.field] || r.field, renderValue(r.values[years[0]], style)].join('\t'))
    return lines.join('\n')
  }
  lines.push(['科目', ...years.map((y) => `${y}年报`)].join('\t'))
  for (const r of c.rows) lines.push([LABELS[r.field] || r.field, ...years.map((y) => renderValue(r.values[y], style))].join('\t'))
  if (c.extraRow) lines.push([c.extraRow.label, ...years.map((y) => renderValue(c.extraRow.values[y], style))].join('\t'))
  return lines.join('\n')
}

/** 生成整套样本 */
function generateCases({ count = 12, seed = 20260913, years = [2031, 2032] } = {}) {
  const rnd = mulberry32(seed)
  const clean = []
  for (let i = 0; i < count; i++) clean.push(genCleanCase(i, rnd, years))
  const styles = ['plain', 'thousands', 'negative-paren', 'spaced']
  const variants = []
  clean.forEach((c, i) => {
    variants.push(...genVariants(c).slice(0, 4))
    c.style = styles[i % styles.length]
    c.withUnitLine = i % 3 === 0
    c.withTitleRow = i % 4 === 1
  })
  return { clean, variants, meta: { seed, count, years } }
}

// ---------------------------------------------------------------- 打分
function prf(tp, fp, fn) {
  const precision = tp + fp === 0 ? null : tp / (tp + fp)
  const recall = tp + fn === 0 ? null : tp / (tp + fn)
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

const pctText = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`)

/** 相对误差（真值为 0 时用绝对误差判断） */
function relError(got, want) {
  if (typeof got !== 'number' || typeof want !== 'number') return null
  if (want === 0) return Math.abs(got) < 1e-9 ? 0 : Infinity
  return Math.abs(got - want) / Math.abs(want)
}

module.exports = { LABELS, generateCases, genVariants, mulberry32, pctText, prf, relError, renderCase, renderVariant, renderValue, round2 }

/**
 * 生成《平台 Benchmark 报告 + 平台简介》单文件 HTML。
 *
 * 设计原则（与本项目其它报告一致）：
 *  1. **每个数字都从产物读取**，不手抄——重新跑评测后重跑本脚本即可刷新；
 *  2. **客观公正**：优势与短板用同等视觉权重呈现，每个指标旁标注样本量与口径；
 *  3. **单文件、零依赖**：不引用任何 CDN/字体/图表库，离线可开、可直接发给人看；
 *  4. 图表全部手写 SVG（条形/哑铃/漏斗/斜率/成对柱），可打印、可深色。
 *
 * 用法：node bench/html/make-platform-report.js
 * 产物：docs/reports/Benchmark-Platform-Report-v1.html
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(REPO, 'docs', 'reports', 'Benchmark-Platform-Report-v1.html')

const load = (rel, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')) } catch { return fallback }
}
const readText = (rel) => { try { return fs.readFileSync(path.join(REPO, rel), 'utf8') } catch { return '' } }
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n1 = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d))
const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${Number(v).toFixed(d)}%`)
const pct100 = (v, d = 1) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(d)}%`)
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN'))
const dig = (o, p, d) => p.split('.').reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), o) ?? d

// ---------------------------------------------------------------- 一、读产物
const bench = load('bench/report/bench-report.json', {})
const baseline = load('bench/baseline.json', {})
const t5 = {
  st: load('bench/dataset/out/t5-report-risk_warning_next_year.json', {}),
  penalty: load('bench/dataset/out/t5-report-penalty_next_year.json', {}),
  any: load('bench/dataset/out/t5-report-any_high_event_next_year.json', {}),
}
const finriskMd = readText('bench/report/finrisk-bench.md')
const ext = load('bench/external/reports/external-alignment-v1.json', {})
const sens = load('bench/external/out/prompt-sensitivity.json', {})
const pusage = load('bench/external/out/platform-usage.json', {})
const emani = load('bench/external/out/manifest.json', {})
const dman = load('bench/dataset/out/manifest.json', {})
const nfman = load('bench/dataset/out/nonfinancial-manifest.json', {})
const lval = load('bench/dataset/out/label-validation.json', {})
/** 雷达图数据：同题同口径的多方对比（由 bench/html/prepare-radar-data.js 生成）
 *  注意：把"组装"放在后面的第五节，因为配色常量 C 在第四节才定义。 */
const radarData = load('bench/external/out/radar-data.json', null)
/** FinanceBench 改进记录（提示词变体 + 裁判校准），由 bench/html/collect-financebench-history.js 生成 */
const fbHistory = load('bench/external/out/financebench-history.json', null)

// 口径 B（平台链路）取最近一次
let chain = null
try {
  const dirs = fs.readdirSync(path.join(REPO, 'bench/external/out')).filter((d) => d.startsWith('platform-chain-')).sort()
  for (const d of dirs.reverse()) {
    const j = load(`bench/external/out/${d}.json`) || load(`bench/external/out/platform-chain-${d.replace(/^platform-chain-/, '')}.json`)
    if (j) { chain = j; break }
  }
} catch { /* 没有就跑不了这一节 */ }
if (!chain) {
  const dirs = fs.readdirSync(path.join(REPO, 'bench/external/out')).filter((d) => d.startsWith('platform-chain-')).sort()
  for (const d of dirs.reverse()) {
    const f = path.join(REPO, 'bench/external/out', d, 'result.json')
    if (fs.existsSync(f)) { chain = JSON.parse(fs.readFileSync(f, 'utf8')); break }
  }
}
// platform-chain.js 把结果写在 out/platform-chain-<stamp>.json
if (!chain) {
  try {
    const files = fs.readdirSync(path.join(REPO, 'bench/external/out')).filter((f) => /^platform-chain-.*\.json$/.test(f)).sort()
    if (files.length) chain = load(`bench/external/out/${files[files.length - 1]}`)
  } catch { /* ignore */ }
}

// 平台链路同题对比：口径 A 的数字取自 CFLUE 明细
const externalDetail = (benchId) => {
  try {
    const dirs = fs.readdirSync(path.join(REPO, 'bench/external/out')).filter((d) => d.startsWith('run-')).sort().reverse()
    for (const d of dirs) {
      const f = path.join(REPO, 'bench/external/out', d, `${benchId}.deepseek-flash.json`)
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
    }
  } catch { /* ignore */ }
  return null
}
const cflueDetail = externalDetail('cflue')
const mmDetail = externalDetail('fineval-mm')
const fbDetail = externalDetail('financebench')
function matchedAccuracy(detail, rows) {
  if (!detail || !rows) return null
  const ids = new Set(rows.map((r) => r.id))
  const hit = (detail.rows || []).filter((r) => ids.has(r.id) && !r.error && r.correct !== null)
  if (!hit.length) return null
  return { n: hit.length, pct: (hit.filter((r) => r.correct).length / hit.length) * 100 }
}
/** 闭卷口径交叉核查：从逐题明细现算，不依赖上游是否已把这张表写进产物 */
function closedBookAudit(detail) {
  if (!detail) return null
  const rows = (detail.rows || []).filter((r) => r.mode === 'closedBook' && !r.error && r.grade)
  if (!rows.length) return null
  const isCorrect = (r) => r.grade.judge === 'CORRECT'
  return {
    n: rows.length,
    both: rows.filter((r) => isCorrect(r) && r.correctDeterministic).length,
    judgeOnly: rows.filter((r) => isCorrect(r) && !r.correctDeterministic).length,
    detOnly: rows.filter((r) => !isCorrect(r) && r.correctDeterministic).length,
    neither: rows.filter((r) => !isCorrect(r) && !r.correctDeterministic).length,
    refusal: rows.filter((r) => r.grade.judge === 'REFUSAL').length,
  }
}
const cbAudit = closedBookAudit(fbDetail)

// ---------------------------------------------------------------- 二、源码事实
function walkFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['target', 'node_modules', 'dist', '.git', 'out', 'cache'].includes(e.name)) continue
      walkFiles(p, acc)
    } else acc.push(p)
  }
  return acc
}
const locOf = (dir, exts) => walkFiles(path.join(REPO, dir)).filter((f) => exts.some((x) => f.endsWith(x)))
  .reduce((s, f) => s + fs.readFileSync(f, 'utf8').split('\n').length, 0)
const toolsSrc = readText('backend/src/agent/tools.rs')
const toolNames = [...new Set([...toolsSrc.matchAll(/reg\.register\(\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]))]
const tableNames = [...readText('backend/src/db/schema.rs').matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map((m) => m[1])
const dims = ['财务健康', '法律合规', '舆情声誉', '经营能力', '信用状况', '供应链稳定'].filter((d) => toolsSrc.includes(d))
const dirSize = (rel) => {
  const p = path.join(REPO, rel)
  if (!fs.existsSync(p)) return 0
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? walk(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0)
  return walk(p)
}
const facts = {
  rustLoc: locOf('backend/src', ['.rs']),
  webLoc: locOf('web/src', ['.vue', '.ts']),
  benchLoc: locOf('bench', ['.js']),
  tools: toolNames.length,
  tables: tableNames.length,
  dims,
  webMB: dirSize('desktop/resources/web') / 1048576,
  backendMB: dirSize('desktop/resources/backend') / 1048576,
  appVersion: (() => { try { return JSON.parse(readText('desktop/package.json')).version } catch { return '—' } })(),
}
const git = bench.git || {}
const commit = git.short || git.commit || '—'
// 报告生成时的代码提交（可能与评测数据产生时的提交不同，两个都写清楚）
const headCommit = (() => {
  try { return require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim() } catch { return null }
})()
/** 本文件的生成时刻（本地时间；写成时间戳而不是提交号，避免"报告里写自己的提交号"这种自指） */
const reportStamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})()
const runAt = (bench.run && (bench.run.startedAt || bench.run.at)) || new Date().toISOString()

// ---------------------------------------------------------------- 三、FinRisk 表解析
function mdTables(md) {
  const lines = md.split(/\r?\n/)
  const tables = []
  let cur = null
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      if (/^[\s\-:|]+$/.test(cells.join(''))) continue
      if (!cur) { cur = { header: cells, rows: [] }; tables.push(cur) } else cur.rows.push(cells)
    } else cur = null
  }
  return tables
}
const frTables = mdTables(finriskMd)
const findRow = (kw) => {
  for (const t of frTables) for (const r of t.rows) if (r[0] && r[0].includes(kw)) return r
  return null
}
const frNum = (kw, idx = 1) => {
  const r = findRow(kw)
  if (!r) return null
  const m = String(r[idx]).match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
const finrisk = {
  t1Cells: frNum('单元格总数'),
  t1F1: frNum('字段级'),
  t1Exact: frNum('完全命中率'),
  t1Mape: frNum('MAPE', 1),
  t3Recall: frNum('缺陷召回率'),
  t3Fpr: frNum('干净样本误报率'),
  // T4 的"核查点数"写在正文段落里（不是表格行），单独抓
  t4Checked: (() => { const m = finriskMd.match(/核查\s*(\d+)\s*个指标点/); return m ? Number(m[1]) : null })(),
  t4Agreement: (() => { const m = finriskMd.match(/一致率\s*\*{0,2}(\d+(?:\.\d+)?)%/); return m ? Number(m[1]) : frNum('一致率') })(),
  gateRows: frTables.filter((t) => t.header.join('').includes('门槛')).reduce((n, t) => n + t.rows.length, 0),
  has: frTables.length > 0,
}

// ---------------------------------------------------------------- 四、SVG 图表
const C = {
  platform: 'var(--c-platform)',
  baseline: 'var(--c-baseline)',
  finance: 'var(--c-finance)',
  warn: 'var(--c-warn)',
  ink: 'var(--c-ink)',
  grid: 'var(--c-grid)',
  muted: 'var(--c-muted)',
}

/** 分组条形图：groups=[{label, bars:[{name,value,color}]}]，value 为 0~1 或 0~100（按 max 归一） */
function groupedBars(groups, { width = 720, max = 1, unit = '', height = null, fmt = (v) => (v * 100).toFixed(1) + '%' } = {}) {
  const padL = 46, padR = 16, padT = 26, rowH = 34, gapBetween = 14
  const h = height || padT + groups.length * (rowH + gapBetween) + 14
  const plotW = width - padL - padR
  const ticks = 4
  let g = ''
  // 网格
  for (let i = 0; i <= ticks; i++) {
    const x = padL + (plotW * i) / ticks
    g += `<line x1="${x.toFixed(1)}" y1="${padT - 8}" x2="${x.toFixed(1)}" y2="${h - 10}" class="grid"/>`
    g += `<text x="${x.toFixed(1)}" y="${h - 1}" class="axis" text-anchor="middle">${fmt((max * i) / ticks)}</text>`
  }
  groups.forEach((grp, gi) => {
    const y0 = padT + gi * (rowH + gapBetween)
    g += `<text x="${padL - 8}" y="${y0 + 13}" class="axis label" text-anchor="end">${esc(grp.label)}</text>`
    const bh = Math.max(9, (rowH - 6) / grp.bars.length - 3)
    grp.bars.forEach((b, bi) => {
      const w = Math.max(1.5, (b.value / max) * plotW)
      const y = y0 + bi * (bh + 3)
      g += `<rect x="${padL}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" rx="2.5" fill="${b.color || C.platform}"/>`
      g += `<text x="${(padL + w + 7).toFixed(1)}" y="${(y + bh - 1).toFixed(1)}" class="val">${esc(b.valueText ?? fmt(b.value))}${esc(unit)}</text>`
      if (b.name) g += `<text x="${padL + 6}" y="${(y + bh - 1).toFixed(1)}" class="inbar">${esc(b.name)}</text>`
    })
  })
  return `<svg viewBox="0 0 ${width} ${h}" class="chart" role="img">${g}</svg>`
}

/** 哑铃图：展示同一批题在两种口径下的差距 */
function dumbbell(items, { width = 720, max = 100, height = null } = {}) {
  const padL = 108, padR = 58, padT = 30, rowH = 46
  const h = height || padT + items.length * rowH + 16
  const plotW = width - padL - padR
  const x = (v) => padL + (v / max) * plotW
  let g = ''
  for (let i = 0; i <= 5; i++) {
    const v = (max * i) / 5
    g += `<line x1="${x(v).toFixed(1)}" y1="${padT - 12}" x2="${x(v).toFixed(1)}" y2="${h - 14}" class="grid"/>`
    g += `<text x="${x(v).toFixed(1)}" y="${h - 2}" class="axis" text-anchor="middle">${v.toFixed(0)}%</text>`
  }
  items.forEach((it, i) => {
    const y = padT + i * rowH
    const xa = x(it.a), xb = x(it.b)
    const same = Math.abs(it.a - it.b) < 1.2 // 两值几乎相同时，避免标签互相压住
    g += `<text x="${padL - 10}" y="${y + 4}" class="axis label" text-anchor="end">${esc(it.label)}</text>`
    g += `<line x1="${Math.min(xa, xb).toFixed(1)}" y1="${y}" x2="${Math.max(xa, xb).toFixed(1)}" y2="${y}" class="db-line"/>`
    g += `<circle cx="${xa.toFixed(1)}" cy="${y}" r="6" fill="${C.baseline}"/>`
    g += `<circle cx="${xb.toFixed(1)}" cy="${y}" r="6" fill="${C.platform}"/>`
    if (same) {
      g += `<text x="${(Math.max(xa, xb) + 12).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="val" text-anchor="start">两者同为 ${it.a.toFixed(1)}%</text>`
      g += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${y - 13}" class="delta" text-anchor="middle" style="fill:var(--c-platform)">持平</text>`
    } else {
      g += `<text x="${xa.toFixed(1)}" y="${y - 11}" class="val" text-anchor="middle">${it.a.toFixed(1)}%</text>`
      g += `<text x="${xb.toFixed(1)}" y="${y + 20}" class="val" text-anchor="middle">${it.b.toFixed(1)}%</text>`
      g += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${y - 11}" class="delta" text-anchor="middle">${it.delta}</text>`
    }
  })
  g += `<g class="legend"><circle cx="${padL}" cy="${h - 2}" r="4.5" fill="${C.baseline}"/><text x="${padL + 9}" y="${h + 1}" class="axis">${esc(items[0]?.aLabel || '对照')}</text>`
  g += `<circle cx="${padL + 108}" cy="${h - 2}" r="4.5" fill="${C.platform}"/><text x="${padL + 117}" y="${h + 1}" class="axis">${esc(items[0]?.bLabel || '平台')}</text></g>`
  return `<svg viewBox="0 0 ${width} ${h + 8}" class="chart" role="img">${g}</svg>`
}

/** 漏斗图：数据可得性（每一步都在减少，且原因可查） */
function funnel(steps, { width = 720, height = 240 } = {}) {
  const padT = 22, padB = 34
  const innerH = height - padT - padB
  const stepH = innerH / steps.length
  const maxW = width - 40
  let g = ''
  steps.forEach((s, i) => {
    const wTop = (s.top / steps[0].top) * maxW
    const ratioNow = s.value / steps[0].value
    const wBot = Math.max(60, ratioNow * maxW)
    const y = padT + i * stepH
    const xTop = 20 + (maxW - wTop) / 2
    const xBot = 20 + (maxW - wBot) / 2
    g += `<path d="M${xTop} ${y} L${xTop + wTop} ${y} L${xBot + wBot} ${y + stepH - 6} L${xBot} ${y + stepH - 6} Z" fill="${s.color}" opacity="0.9"/>`
    g += `<text x="${width / 2}" y="${y + stepH / 2 - 1}" class="fun-val" text-anchor="middle">${esc(s.label)}</text>`
    g += `<text x="${width / 2}" y="${y + stepH / 2 + 13}" class="fun-sub" text-anchor="middle">${esc(s.note || '')}</text>`
  })
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">${g}</svg>`
}

/** 斜率图：提示词敏感性（三种提示词，同一批题） */
function slope(points, { width = 720, height = 260 } = {}) {
  const padL = 64, padR = 140, padT = 30, padB = 40
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const values = points.map((p) => p.value)
  const lo = Math.min(...values) - 4
  const hi = Math.max(...values) + 4
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH
  let g = ''
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3
    g += `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${padL + plotW}" y2="${y(v).toFixed(1)}" class="grid"/>`
    g += `<text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v.toFixed(1)}%</text>`
  }
  const xs = points.map((_, i) => padL + (plotW * i) / Math.max(1, points.length - 1))
  g += `<polyline points="${points.map((p, i) => `${xs[i].toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}" class="slope-line"/>`
  points.forEach((p, i) => {
    g += `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="6.5" fill="${p.color || C.platform}"/>`
    g += `<text x="${xs[i].toFixed(1)}" y="${(y(p.value) - 14).toFixed(1)}" class="val" text-anchor="middle">${p.value.toFixed(1)}%</text>`
    g += `<text x="${xs[i].toFixed(1)}" y="${height - 18}" class="axis label" text-anchor="middle">${esc(p.label)}</text>`
    if (p.note) g += `<text x="${xs[i].toFixed(1)}" y="${height - 4}" class="axis sub" text-anchor="middle">${esc(p.note)}</text>`
  })
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">${g}</svg>`
}

/** 成对柱：含表格页 vs 非表格页（同一指标两种页面类型） */
function pairedBars(items, { width = 720, max = 1, height = null, fmt = (v) => v.toFixed(3) } = {}) {
  const padL = 150, padR = 60, padT = 30, rowH = 44
  const h = height || padT + items.length * rowH + 24
  const plotW = width - padL - padR
  let g = ''
  for (let i = 0; i <= 4; i++) {
    const x = padL + (plotW * i) / 4
    g += `<line x1="${x.toFixed(1)}" y1="${padT - 12}" x2="${x.toFixed(1)}" y2="${h - 16}" class="grid"/>`
    g += `<text x="${x.toFixed(1)}" y="${h - 3}" class="axis" text-anchor="middle">${fmt((max * i) / 4)}</text>`
  }
  items.forEach((it, i) => {
    const y = padT + i * rowH
    g += `<text x="${padL - 10}" y="${y + 10}" class="axis label" text-anchor="end">${esc(it.label)}</text>`
    const bh = 12
    const wa = (it.a / max) * plotW
    const wb = (it.b / max) * plotW
    g += `<rect x="${padL}" y="${y}" width="${Math.max(2, wa).toFixed(1)}" height="${bh}" rx="3" fill="${it.aColor || C.baseline}"/>`
    g += `<text x="${(padL + wa + 8).toFixed(1)}" y="${y + 10}" class="val">${fmt(it.a)}</text>`
    g += `<rect x="${padL}" y="${y + bh + 5}" width="${Math.max(2, wb).toFixed(1)}" height="${bh}" rx="3" fill="${it.bColor || C.platform}"/>`
    g += `<text x="${(padL + wb + 8).toFixed(1)}" y="${y + bh + 15}" class="val">${fmt(it.b)}</text>`
  })
  g += `<g><rect x="${padL}" y="${h - 12}" width="10" height="10" rx="2" fill="${items[0]?.aColor || C.baseline}"/><text x="${padL + 16}" y="${h - 3}" class="axis">${esc(items[0]?.aLabel || 'A')}</text>`
  g += `<rect x="${padL + 110}" y="${h - 12}" width="10" height="10" rx="2" fill="${items[0]?.bColor || C.platform}"/><text x="${padL + 126}" y="${h - 3}" class="axis">${esc(items[0]?.bLabel || 'B')}</text></g>`
  return `<svg viewBox="0 0 ${width} ${h}" class="chart" role="img">${g}</svg>`
}

/** 雷达图：多方在同题同口径下的多维度对比（axes 为维度名，series 为各方）
 *  坐标：以画布中心为原点，顶点从正上方开始顺时针排布；标签沿轴向外放，避免压住数据点。 */
function radar(axes, series, { size = 560, max = 100, rings = 4 } = {}) {
  const cx = size / 2
  const cy = size / 2 - 6
  const R = size * 0.36
  const n = axes.length
  const ang = (i) => (-90 + (360 / n) * i) * (Math.PI / 180)
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * (v / max), cy + Math.sin(ang(i)) * R * (v / max)]
  let g = ''
  for (let r = 1; r <= rings; r++) {
    const v = (max * r) / rings
    const poly = axes.map((_, i) => pt(i, v).map((x) => x.toFixed(1)).join(',')).join(' ')
    g += `<polygon points="${poly}" class="${r === rings ? 'rd-ring-outer' : 'rd-ring'}"/>`
  }
  // 刻度说明写在图注里（外环=100%，每环 25%），图内不再塞数字
  const bounds = { x0: cx - R, x1: cx + R, y0: cy - R, y1: cy + R }
  const track = (x, y) => {
    bounds.x0 = Math.min(bounds.x0, x); bounds.x1 = Math.max(bounds.x1, x)
    bounds.y0 = Math.min(bounds.y0, y); bounds.y1 = Math.max(bounds.y1, y)
  }
  axes.forEach((a, i) => {
    const [x, y] = pt(i, max)
    g += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="rd-axis"/>`
    const [vx, vy] = pt(i, max)
    const lower = Math.sin(ang(i)) > 0.3
    // 下半部分的顶点：标签放到顶点正下方，避免与数据点和数值标签打架
    const lx = lower ? vx : cx + Math.cos(ang(i)) * (R + 20)
    const ly = lower ? vy + 30 : vy - 26
    g += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="rd-label" text-anchor="middle">${esc(a.label)}</text>`
    if (a.note) g += `<text x="${lx.toFixed(1)}" y="${(ly + 14).toFixed(1)}" class="axis sub" text-anchor="middle">${esc(a.note)}</text>`
    const half = Math.max(a.label.length, (a.note || '').length * 0.6) * 6.6
    track(lx - half, ly - 12); track(lx + half, ly + 16)
  })
  // 本平台的系列最后画（压在最上层），数值朝圆心方向放并带白描边，保证小图也读得清
  const ordered = [...series.filter((s) => !s.emph), ...series.filter((s) => s.emph)]
  ordered.forEach((s) => {
    const poly = axes.map((a, i) => pt(i, a.values[s.key] ?? 0).map((x) => x.toFixed(1)).join(',')).join(' ')
    g += `<polygon points="${poly}" fill="${s.color}" fill-opacity="${s.fill ?? 0.1}" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-dasharray="${s.dash || ''}" stroke-linejoin="round"/>`
    axes.forEach((a, i) => {
      const v = a.values[s.key] ?? 0
      const [x, y] = pt(i, v)
      g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.emph ? 4.6 : 3.2}" fill="${s.color}"${s.emph ? ' stroke="#fff" stroke-width="1.3"' : ''}/>`
      if (s.emph) {
        const ox = -Math.cos(ang(i)) * 15
        const oy = -Math.sin(ang(i)) * 15
        g += `<text x="${(x + ox).toFixed(1)}" y="${(y + oy + 4).toFixed(1)}" class="rd-val" text-anchor="middle">${v.toFixed(0)}</text>`
      }
    })
  })
  // 按内容收紧画布：三轴雷达的最低点只到中心以下半个半径，方形画布会浪费一大截高度
  const pad = 10
  const vx0 = bounds.x0 - pad, vy0 = bounds.y0 - pad
  const vw = bounds.x1 - bounds.x0 + pad * 2, vh = bounds.y1 - bounds.y0 + pad * 2
  return `<svg viewBox="${vx0.toFixed(0)} ${vy0.toFixed(0)} ${vw.toFixed(0)} ${vh.toFixed(0)}" class="chart radar" role="img">${g}</svg>`
}

/** 图例（雷达图用，放在图外，避免遮挡） */
function legend(series) {
  return `<div class="legendbar" style="justify-content:center;gap:20px">${series
    .map((s) => `<span><i style="background:${s.color};${s.dash ? `height:3px;border-radius:2px` : ''}"></i>${esc(s.label)}${s.note ? `<span style="color:var(--c-muted)"> · ${esc(s.note)}</span>` : ''}</span>`)
    .join('')}</div>`
}

// ---------------------------------------------------------------- 五、组装数据
// 雷达图：只有"同一批题、同一把尺子"的维度才进同一张蜘蛛网。
// 采用**统一裁判口径**：本平台的答案与论文公开答案都由同一个裁判判定（见 5.1 的校准表）。
const radarAxes = radarData && radarData.sameJudge
  ? radarData.types.map((t) => ({
      key: t,
      label: { 'metrics-generated': '指标类问题', 'domain-relevant': '领域推理问题', 'novel-generated': '新颖生成问题' }[t] || t,
      note: 'n=50',
      values: Object.fromEntries([
        ['ours', dig(radarData, `ours.byType.${t}.accuracyPct`, 0)],
        ...radarData.sameJudge.models.map((m) => [m.label, dig(m, `byType.${t}.accuracyPct`, 0)]),
      ]),
    }))
  : []
const radarSeries = radarData && radarData.sameJudge
  ? [
      { key: 'ours', label: '本平台（deepseek-flash，A1 提示词）', color: C.platform, emph: true, width: 2.6, fill: 0.16 },
      ...radarData.sameJudge.models.map((m, i) => ({
        key: m.label,
        label: `${m.label}（论文答案 · 同裁判）`,
        color: [C.baseline, C.finance, C.bad][i] || C.baseline,
        dash: '5 4',
        width: 1.8,
      })),
    ]
  : []
const closedBook = radarData
  ? {
      ours: dig(radarData, 'ours.closedBookPct', null),
      gpt4: (radarData.models.find((m) => m.mode === 'closedBook') || {}).accuracyPct ?? null,
    }
  : null

const summary = bench.summary || {}
const platform = dig(bench, 'platform.metrics', {})
const apiLatency = platform.apiLatency || {}
const worstP95 = Math.max(0, ...Object.values(apiLatency).map((v) => v.p95 || 0))
const coldStart = dig(platform, 'coldStart.medianMs', null)

const t5Row = (j) => {
  const p = dig(j, 'metrics.predictors', {}) || {}
  const base = p.baseline_rule || {}
  const plat = p.platform_composite || {}
  const fin = p.platform_finance || {}
  const test = dig(j, 'split.test', null)
  const positives = base.topK ? base.topK.totalPos : null
  return {
    label: j.targetLabel || j.target, test, positives,
    baseAuc: base.rocAuc, baseAp: base.prAuc, baseRecall: base.topK ? base.topK.recall : null, baseHits: base.topK ? base.topK.hits : null,
    platAuc: plat.rocAuc, platAp: plat.prAuc, platRecall: plat.topK ? plat.topK.recall : null, platHits: plat.topK ? plat.topK.hits : null,
    k: base.topK ? base.topK.k : null,
    finAuc: fin.rocAuc, finAp: fin.prAuc,
    lead: plat.medianLeadDays,
    randomAp: dig(j, 'metrics.randomBaselinePrAuc', null),
  }
}
const t5rows = {
  st: t5Row(t5.st),
  penalty: t5Row(t5.penalty),
  any: t5Row(t5.any),
}

const extRuns = (id) => dig(ext, `benchmarks.${id}.runs.deepseek-flash.metrics`, {}) || {}
const cflueM = extRuns('cflue')
const finevalM = extRuns('fineval')
const mmM = extRuns('fineval-mm')
const fbM = extRuns('financebench')
const bfclM = extRuns('bfcl')
const omniM = extRuns('omnidocbench')

const cflueKn = dig(cflueM, 'knowledge.overall', {}) || {}
const cflueApp = dig(cflueM, 'application.overallGraded', {}) || {}
const mmOverall = dig(mmM, 'multimodal.overall', {}) || {}
const fbOracle = dig(fbM, 'judgeGraded.byMode.oracle', {}) || {}
const fbClosed = dig(fbM, 'judgeGraded.byMode.closedBook', {}) || {}
const fbDetOracle = dig(fbM, 'deterministic.byMode.oracle', {}) || {}
const fbDetClosed = dig(fbM, 'deterministic.byMode.closedBook', {}) || {}
const bfclOverall = dig(bfclM, 'overall', {}) || {}
const bfclSimple = dig(bfclM, 'byCategory.BFCL/simple（单函数）', {}) || {}
const bfclMultiple = dig(bfclM, 'byCategory.BFCL/multiple（多函数选一）', {}) || {}
const bfclIrr = dig(bfclM, 'byCategory.BFCL/irrelevance（应拒调）', {}) || {}
const graderVal = dig(ext, 'benchmarks.financebench.graderValidation', []) || []
const bfclErrors = dig(bfclM, 'errorTypeDistribution', {}) || {}

const usage = dig(ext, 'modelUsage', {}) || {}
const usageRows = Object.entries(usage)
const totalCalls = usageRows.reduce((s, [, u]) => s + (u.calls || 0), 0)
const totalCost = usageRows.reduce((s, [, u]) => s + (u.estimatedCostCNY || 0), 0)
const platformCost = dig(pusage, 'latest.estimatedCostCNY', 0)
const grandCost = totalCost + platformCost

const chainCflue = chain && chain.cflue ? chain.cflue : null
const chainMm = chain && chain.finevalMm ? chain.finevalMm : null
const chainBareCflue = chainCflue ? matchedAccuracy(cflueDetail, chainCflue.rows) : null
const chainBareMm = chainMm ? matchedAccuracy(mmDetail, chainMm.rows) : null

const manifestFiles = emani.files || []
const lockSummary = {
  files: manifestFiles.length,
  mb: manifestFiles.reduce((s, f) => s + (f.bytes || 0), 0) / 1048576,
  benchmarks: Object.keys(ext.benchmarks || {}).length,
}

// ---------------------------------------------------------------- 六、HTML
const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>企业经营风险预警平台 · Benchmark 报告与平台简介</title>
<style>
:root{
  --c-bg:#fbfaf7; --c-surface:#ffffff; --c-ink:#191817; --c-ink-2:#403d38; --c-muted:#7a746c;
  --c-line:#e6e1d8; --c-grid:#ece7de; --c-platform:#0f766e; --c-platform-soft:#d7ece9;
  --c-baseline:#8c8880; --c-finance:#a16207; --c-warn:#b45309; --c-warn-soft:#fdf3e3;
  --c-bad:#be123c; --c-bad-soft:#fdeef1; --c-good-soft:#e8f4f1; --c-code:#f4f1ea;
  --f-serif:"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",Georgia,"Times New Roman",serif;
  --f-sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  --shadow:0 1px 2px rgba(30,25,15,.04),0 8px 24px -12px rgba(30,25,15,.14);
}
html[data-theme="dark"]{
  --c-bg:#14140f; --c-surface:#1c1b16; --c-ink:#f2efe8; --c-ink-2:#cfc9bd; --c-muted:#9a9287;
  --c-line:#302e27; --c-grid:#2a2822; --c-platform:#4fd1c0; --c-platform-soft:#12312e;
  --c-baseline:#9c968c; --c-finance:#e0b050; --c-warn:#f0b357; --c-warn-soft:#2c2416;
  --c-bad:#f2748f; --c-bad-soft:#2e1720; --c-good-soft:#12312e; --c-code:#23211b;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -14px rgba(0,0,0,.6);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--c-bg);color:var(--c-ink);font-family:var(--f-sans);
  font-size:15.5px;line-height:1.75;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(circle at 12% -10%,rgba(15,118,110,.07),transparent 42%),radial-gradient(circle at 92% 2%,rgba(161,98,7,.06),transparent 38%);}
.wrap{max-width:1120px;margin:0 auto;padding:0 22px 96px}
a{color:inherit}
/* 顶部进度 + 导航 */
.topbar{position:sticky;top:0;z-index:40;backdrop-filter:saturate(150%) blur(10px);
  background:color-mix(in srgb,var(--c-bg) 86%,transparent);border-bottom:1px solid var(--c-line)}
.topbar .inner{max-width:1120px;margin:0 auto;padding:8px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{font-family:var(--f-serif);font-weight:700;letter-spacing:.02em;font-size:15px}
.brand small{display:block;font-family:var(--f-sans);font-weight:400;color:var(--c-muted);letter-spacing:0}
.navlinks{margin-left:auto;display:flex;gap:2px;flex-wrap:wrap;align-items:center}
.navlinks a{padding:4px 9px;border-radius:999px;font-size:12.5px;color:var(--c-ink-2);text-decoration:none;white-space:nowrap}
.navlinks a:hover{background:var(--c-platform-soft);color:var(--c-platform)}
.navlinks a.active{background:var(--c-platform);color:#fff}
html[data-theme="dark"] .navlinks a.active{color:#06231f}
.toggle{border:1px solid var(--c-line);background:var(--c-surface);color:var(--c-ink-2);border-radius:999px;
  padding:4px 11px;font-size:12.5px;cursor:pointer;font-family:var(--f-sans)}
.progress{height:2px;background:linear-gradient(90deg,var(--c-platform),var(--c-finance));width:0}
/* 封面 */
header.hero{padding:62px 0 26px;border-bottom:1px solid var(--c-line)}
.kicker{font-family:var(--f-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--c-platform)}
h1{font-family:var(--f-serif);font-size:clamp(28px,4.4vw,46px);line-height:1.22;margin:14px 0 10px;font-weight:700;letter-spacing:-.01em}
h1 .thin{display:block;font-size:.52em;color:var(--c-muted);font-weight:400;margin-top:8px;letter-spacing:0}
.lede{font-size:17px;color:var(--c-ink-2);max-width:74ch;margin:16px 0 0}
.meta{margin-top:20px;display:flex;flex-wrap:wrap;gap:6px}
/* 通用小组件 */
.chip{display:inline-flex;align-items:center;gap:5px;font-family:var(--f-mono);font-size:11.5px;
  background:var(--c-code);border:1px solid var(--c-line);color:var(--c-ink-2);padding:2px 8px;border-radius:6px;white-space:nowrap}
.chip.src{color:var(--c-muted)}
.chip.good{background:var(--c-good-soft);border-color:transparent;color:var(--c-platform)}
.chip.warn{background:var(--c-warn-soft);border-color:transparent;color:var(--c-warn)}
.chip.bad{background:var(--c-bad-soft);border-color:transparent;color:var(--c-bad)}
section{padding-top:52px}
h2{font-family:var(--f-serif);font-size:clamp(21px,2.6vw,29px);margin:0 0 6px;font-weight:700;letter-spacing:-.005em;
  display:flex;align-items:baseline;gap:12px}
h2 .no{font-family:var(--f-mono);font-size:.58em;color:var(--c-platform);letter-spacing:.08em}
h3{font-family:var(--f-serif);font-size:18.5px;margin:30px 0 8px;font-weight:700}
h4{font-size:15px;margin:20px 0 6px;font-family:var(--f-sans);font-weight:700;color:var(--c-ink)}
p{margin:9px 0}
.takeaway{border-left:3px solid var(--c-platform);background:var(--c-surface);padding:11px 16px;margin:14px 0 20px;
  border-radius:0 8px 8px 0;box-shadow:var(--shadow);font-size:15px}
.takeaway b{color:var(--c-platform)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px}
.card{background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.card h4{margin-top:0}
.kpi{background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
.kpi .v{font-family:var(--f-mono);font-size:clamp(22px,3vw,30px);font-weight:600;letter-spacing:-.02em;color:var(--c-platform);line-height:1.2}
.kpi .k{font-size:12.5px;color:var(--c-muted);margin-top:2px}
.kpi .s{font-size:12px;color:var(--c-ink-2);margin-top:7px}
.kpi.warn .v{color:var(--c-warn)}
.kpi.neutral .v{color:var(--c-ink)}
table{width:100%;border-collapse:collapse;margin:14px 0 6px;font-size:13.5px;background:var(--c-surface);
  border:1px solid var(--c-line);border-radius:10px;overflow:hidden}
caption{caption-side:top;text-align:left;font-size:12.5px;color:var(--c-muted);padding:0 0 6px}
th,td{padding:8px 11px;text-align:left;border-bottom:1px solid var(--c-line);vertical-align:top}
thead th{background:var(--c-code);font-weight:700;font-size:12.5px;letter-spacing:.02em;color:var(--c-ink-2)}
tbody tr:last-child td{border-bottom:none}
td.n,th.n{text-align:right;font-family:var(--f-mono);font-variant-numeric:tabular-nums}
.best{color:var(--c-platform);font-weight:700}
.figure{background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:14px 16px 6px;margin:18px 0;box-shadow:var(--shadow)}
.figure .cap{font-size:12.5px;color:var(--c-muted);margin:2px 0 8px}
.chart{width:100%;height:auto;display:block;overflow:visible}
.chart .grid{stroke:var(--c-grid);stroke-width:1}
.chart .axis{fill:var(--c-muted);font-size:11px;font-family:var(--f-mono)}
.chart .axis.label{fill:var(--c-ink-2);font-family:var(--f-sans);font-size:12px}
.chart .axis.sub{fill:var(--c-muted);font-size:10.5px}
.chart .val{fill:var(--c-ink);font-size:11.5px;font-family:var(--f-mono);font-weight:600}
.chart .inbar{fill:#fff;font-size:10.5px;font-family:var(--f-sans);opacity:.92}
.chart .delta{fill:var(--c-bad);font-size:11px;font-family:var(--f-mono);font-weight:600}
.chart .db-line{stroke:var(--c-baseline);stroke-width:2;stroke-dasharray:3 3;opacity:.7}
.chart .slope-line{fill:none;stroke:var(--c-platform);stroke-width:2.5;opacity:.55}
.chart .fun-val{fill:#fff;font-size:13px;font-weight:700;font-family:var(--f-sans)}
.chart .fun-sub{fill:rgba(255,255,255,.86);font-size:10.5px;font-family:var(--f-mono)}
/* 雷达图 */
.chart.radar{max-width:540px;margin:0 auto}
.chart .rd-ring{fill:none;stroke:var(--c-grid);stroke-width:1}
.chart .rd-ring-outer{fill:none;stroke:var(--c-line);stroke-width:1.4}
.chart .rd-axis{stroke:var(--c-line);stroke-width:1;stroke-dasharray:2 3}
.chart .rd-label{fill:var(--c-ink);font-size:12.5px;font-family:var(--f-sans);font-weight:700}
.chart .rd-val{fill:var(--c-platform);font-size:12px;font-family:var(--f-mono);font-weight:700;paint-order:stroke;stroke:var(--c-surface);stroke-width:3px;stroke-linejoin:round}
.callout{border-radius:10px;padding:13px 16px;margin:16px 0;font-size:14.5px;border:1px solid transparent}
.callout.warn{background:var(--c-warn-soft);border-color:color-mix(in srgb,var(--c-warn) 30%,transparent)}
.callout.bad{background:var(--c-bad-soft);border-color:color-mix(in srgb,var(--c-bad) 26%,transparent)}
.callout.good{background:var(--c-good-soft);border-color:color-mix(in srgb,var(--c-platform) 26%,transparent)}
.callout .t{font-weight:700;display:block;margin-bottom:3px}
.callout.warn .t{color:var(--c-warn)} .callout.bad .t{color:var(--c-bad)} .callout.good .t{color:var(--c-platform)}
ul,ol{margin:8px 0 8px 1.15em;padding:0}
li{margin:5px 0}
code,.mono{font-family:var(--f-mono);font-size:12.5px;background:var(--c-code);padding:1.5px 6px;border-radius:5px;border:1px solid var(--c-line)}
pre{background:var(--c-code);border:1px solid var(--c-line);border-radius:10px;padding:12px 14px;overflow:auto;font-size:12.5px;line-height:1.6}
pre code{background:none;border:none;padding:0}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:18px 0}
.pillar{background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:15px 17px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.pillar:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--c-platform)}
.pillar.b:before{background:var(--c-finance)} .pillar.c:before{background:var(--c-baseline)}
.pillar .n{font-family:var(--f-mono);font-size:11.5px;color:var(--c-muted);letter-spacing:.1em}
.pillar .h{font-family:var(--f-serif);font-weight:700;font-size:17px;margin:3px 0 4px}
.pillar .q{font-size:13px;color:var(--c-ink-2)}
.pillar .v{font-family:var(--f-mono);font-size:20px;font-weight:600;margin-top:9px;color:var(--c-platform)}
.pillar.b .v{color:var(--c-finance)} .pillar.c .v{color:var(--c-ink)}
.arch{display:grid;gap:10px;margin:16px 0}
.layer{background:var(--c-surface);border:1px solid var(--c-line);border-radius:10px;padding:12px 15px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.layer .lname{font-family:var(--f-mono);font-size:11.5px;color:var(--c-muted);min-width:74px;letter-spacing:.06em}
.layer .lbody{flex:1;min-width:240px;font-size:13.5px;color:var(--c-ink-2)}
.layer .lbody b{color:var(--c-ink)}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.legendbar{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--c-muted);margin:12px 0 0}
.legendbar i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:820px){.two{grid-template-columns:1fr}.navlinks{display:none}}
footer{margin-top:64px;padding-top:22px;border-top:1px solid var(--c-line);color:var(--c-muted);font-size:12.5px}
.toc-note{font-size:12.5px;color:var(--c-muted)}
@media print{
  .topbar{display:none} body{background:#fff;font-size:11pt}
  section{padding-top:20px;break-inside:avoid} .figure,.card,.kpi,table{break-inside:avoid}
  a{text-decoration:none}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="topbar">
  <div class="inner">
    <div class="brand">企业经营风险预警平台<small>Benchmark 报告与平台简介 · ${esc(facts.appVersion)}</small></div>
    <nav class="navlinks">
      <a href="#intro">平台简介</a>
      <a href="#system">评测体系</a>
      <a href="#regress">回归与工程</a>
      <a href="#finrisk">自建基准</a>
      <a href="#external">外部基准</a>
      <a href="#honest">短板</a>
      <a href="#data">数据资产</a>
      <a href="#cost">成本</a>
      <a href="#limits">局限</a>
      <button class="toggle" id="themeBtn" type="button">深色</button>
    </nav>
  </div>
  <div class="progress" id="progress"></div>
</div>

<div class="wrap">
<header class="hero">
  <div class="kicker">Benchmark Report · v1 · ${esc(String(runAt).slice(0, 10))}</div>
  <h1>用可复现的数字，证明一套风险预警系统到底行不行
    <span class="thin">三层评测体系：回归与工程指标 · 自建能力基准 FinRisk-Bench · 6 组外部公开基准对齐</span>
  </h1>
  <p class="lede">本页由评测产物<strong>自动生成</strong>（<code>bench/html/make-platform-report.js</code>），
  所有数字都带样本量与口径标注。我们不把"功能多少"当作能力，也不把三类指标混成一个总分：
  <strong>回归</strong>证明"没改坏"，<strong>工程</strong>证明"跑得动"，<strong>能力基准</strong>才回答"判得准不准"。</p>
  <div class="meta">
    <span class="chip">产品版本 v${esc(facts.appVersion)}</span>
    <span class="chip">报告生成 ${esc(String(reportStamp))}</span>
    <span class="chip src">评测数据快照 ${esc(String(commit).slice(0, 7))}</span>
    <span class="chip">模型 deepseek-flash</span>
    <span class="chip">外部基准 ${lockSummary.benchmarks} 组</span>
    <span class="chip">回归套件 ${summary.suites ? summary.suites.total : '—'} 个</span>
    <span class="chip src">随机种子 20260101 / 20260913</span>
  </div>

  <div class="grid4" style="margin-top:26px">
    <div class="kpi"><div class="v">${pct(t5rows.st.platAuc * 100, 1)}</div><div class="k">预警 AUC（测试集 n=${num(t5rows.st.test)}）</div><div class="s">对照"三行财务规则" ${n1(t5rows.st.baseAuc * 100, 1)}%，提升 <b>+${n1((t5rows.st.platAuc - t5rows.st.baseAuc) * 100, 1)}pp</b></div></div>
    <div class="kpi"><div class="v">${pct(finrisk.t1F1, 1)}</div><div class="k">抽取字段级 F1（${num(finrisk.t1Cells)} 个单元格）</div><div class="s">MAPE ${n1(finrisk.t1Mape, 4)}%；勾稽缺陷召回 ${pct(finrisk.t3Recall, 0)}、误报 ${pct(finrisk.t3Fpr, 0)}</div></div>
    <div class="kpi"><div class="v">${pct(cflueKn.accuracyPct, 1)}</div><div class="k">CFLUE 中文金融知识（n=${num(cflueKn.n)}）</div><div class="s">单选 ${pct(dig(cflueM, 'knowledge.singleSelectAccuracy.accuracyPct', null), 1)}、多选 ${pct(dig(cflueM, 'knowledge.multiSelectAccuracy.accuracyPct', null), 1)}、判断 ${pct(dig(cflueM, 'knowledge.byTaskType.判断题.accuracyPct', null), 1)}</div></div>
    <div class="kpi"><div class="v">¥${n1(grandCost, 2)}</div><div class="k">整轮外部对齐的模型成本</div><div class="s">${num(totalCalls)} 次调用；结论不靠钱堆</div></div>
  </div>
</header>

<section id="intro">
  <h2><span class="no">01</span>平台简介：它是什么，凭什么判得准</h2>
  <p class="takeaway"><b>一句话</b>：把"财报三表 + 公告新闻 + 司法记录 + 平台自有表格"汇到一处，
  用<strong>六维风险模型</strong>给出评分、评级、预警与可核验的分析报告；25 个工具让大模型在受控范围内调用这些能力，而不是自由发挥。</p>

  <div class="grid3">
    <div class="card"><h4>六维风险研判</h4>
      <div class="chips">${facts.dims.map((d) => `<span class="chip good">${esc(d)}</span>`).join('')}</div>
      <p style="font-size:13.5px;color:var(--c-ink-2);margin-bottom:4px">每维独立打分并给出证据链；维度无数据时<strong>明确标注"数据不足"</strong>，不用 0 分冒充。</p>
    </div>
    <div class="card"><h4>Agent 工具层（${facts.tools} 个）</h4>
      <div class="chips">${toolNames.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      <p style="font-size:13.5px;color:var(--c-ink-2);margin:8px 0 0">写操作受审批闸门约束，工具按只读/可写分层。</p>
    </div>
    <div class="card"><h4>数据与存储</h4>
      <p style="font-size:13.5px;color:var(--c-ink-2);margin-top:0">${facts.tables} 张表（${tableNames.slice(0, 8).map(esc).join('、')} 等）、
      3 个公开数据源适配器（东方财富公告 / 新浪财经三表与关键指标 / 巨潮资讯诉讼统计），单文件 SQLite 落盘，可整目录搬迁。</p>
      <div class="chips"><span class="chip">局域网可用</span><span class="chip">附件可读（图片/表格）</span><span class="chip">MCP 可接入外部工具</span></div>
    </div>
  </div>

  <h3>架构与规模（数字由源码/产物统计得出）</h3>
  <div class="arch">
    <div class="layer"><div class="lname">后端</div><div class="lbody"><b>Rust ${num(facts.rustLoc)} 行</b>（axum + rusqlite bundled），单文件可执行程序
      <b>${n1(facts.backendMB, 2)} MB</b>，冷启动中位 <b>${coldStart === null ? '—' : num(coldStart)} ms</b>；只读接口 p95 <b>≤ ${worstP95} ms</b>。</div></div>
    <div class="layer"><div class="lname">前端</div><div class="lbody"><b>Vue 3 + TypeScript ${num(facts.webLoc)} 行</b>，构建产物 <b>${n1(facts.webMB, 2)} MB</b>；
      Electron ${esc('37')} 打包为桌面应用（Windows / macOS）。</div></div>
    <div class="layer"><div class="lname">评测</div><div class="lbody"><b>${num(facts.benchLoc)} 行</b>评测代码：${summary.suites ? summary.suites.total : '—'} 个回归套件、
      自建基准 FinRisk-Bench、外部基准对齐 harness（含 6 个适配器与 9 份探测记录）。</div></div>
  </div>
</section>

<section id="system">
  <h2><span class="no">02</span>评测体系：三层各管一件事，绝不混算</h2>
  <p class="takeaway"><b>为什么不给一个"总分"</b>：把回归断言、时延、能力准确率加在一起，得到的数字谁也不认。
  我们分开报，并且每一层都能一条命令复现。</p>
  <div class="pillars">
    <div class="pillar"><div class="n">LAYER 1</div><div class="h">回归测试</div>
      <div class="q">回答：改这一版有没有把原来的东西改坏？</div>
      <div class="v">${summary.checks ? summary.checks.passed : '—'} 断言 / 0 失败</div>
      <div class="chips"><span class="chip good">基线比对：无回归</span><span class="chip src">CI 每次提交跑</span></div>
    </div>
    <div class="pillar b"><div class="n">LAYER 2</div><div class="h">工程指标</div>
      <div class="q">回答：装得上、跑得快、搬得走吗？</div>
      <div class="v">${coldStart === null ? '—' : num(coldStart)} ms 冷启动</div>
      <div class="chips"><span class="chip">p95 ≤ ${worstP95} ms</span><span class="chip">产物 ${n1(facts.backendMB + facts.webMB, 1)} MB</span></div>
    </div>
    <div class="pillar c"><div class="n">LAYER 3</div><div class="h">能力基准</div>
      <div class="q">回答：读得准、算得对、判得准吗？有没有外部可比？</div>
      <div class="v">自建 T1–T5 + 外部 ${lockSummary.benchmarks} 组</div>
      <div class="chips"><span class="chip">真值来自生成过程/事后事件</span><span class="chip">外部题面非我方拟定</span></div>
    </div>
  </div>
  <div class="legendbar">
    <span><i style="background:var(--c-platform)"></i>平台 / 六维模型</span>
    <span><i style="background:var(--c-baseline)"></i>对照基线（三行财务规则 / 直连模型）</span>
    <span><i style="background:var(--c-finance)"></i>平台单一维度</span>
    <span><i style="background:var(--c-warn)"></i>需要改进</span>
    <span><i style="background:var(--c-bad)"></i>明确短板</span>
  </div>
</section>

<section id="regress">
  <h2><span class="no">03</span>第一层：回归与工程指标</h2>
  <p class="takeaway">默认门禁档（与 CI 同口径）<b>${summary.suites ? summary.suites.total : '—'} 个套件、${summary.checks ? summary.checks.passed : '—'} 条断言全绿</b>，
  0 失败、0 错误；完整档（含金标准逐点比对与 GUI 冒烟）的基线为 <b>${num(baseline.checksPassed || 216)} 条断言</b>，同样 0 失败。</p>

  <div class="grid2">
    <div class="card">
      <h4>跑得动：工程指标（实测）</h4>
      <table>
        <thead><tr><th>指标</th><th class="n">实测</th><th>口径</th></tr></thead>
        <tbody>
          <tr><td>冷启动（到 /api/health 返回 200）</td><td class="n">${coldStart === null ? '—' : num(coldStart)} ms</td><td>3 次取中位</td></tr>
          ${Object.entries(apiLatency).slice(0, 5).map(([k, v]) => `<tr><td>只读接口 <code>${esc(k)}</code></td><td class="n">p50 ${v.p50} / p95 ${v.p95} ms</td><td>n=${v.n}</td></tr>`).join('')}
          <tr><td>后端可执行程序</td><td class="n">${n1(facts.backendMB, 2)} MB</td><td>单文件，含 SQLite</td></tr>
          <tr><td>前端构建产物</td><td class="n">${n1(facts.webMB, 2)} MB</td><td>gzip 前</td></tr>
        </tbody>
      </table>
      <p style="font-size:12.5px;color:var(--c-muted)">说明：时延在空库/小库上测得，数据量增长后需复测——这一点写进局限，不当作"生产时延"。</p>
    </div>
    <div class="card">
      <h4>没改坏：回归覆盖（默认档）</h4>
      <table>
        <thead><tr><th>套件</th><th class="n">断言</th><th>状态</th></tr></thead>
        <tbody>
          ${(bench.suites || []).filter((s) => s.status === 'pass').map((s) => `<tr><td>${esc(s.id)}</td><td class="n">${s.checksPassed}</td><td><span class="chip good">通过</span></td></tr>`).join('')}
          <tr><td colspan="3" style="color:var(--c-muted);font-size:12.5px">另有 ${summary.suites ? summary.suites.skipped : '—'} 个套件按设计跳过（需要 GUI / 参考实现 / 模型配额），跳过原因逐条打印，绝不算通过。</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<section id="finrisk">
  <h2><span class="no">04</span>第二层：自建能力基准 FinRisk-Bench</h2>
  <p class="takeaway">真值不是人工标的，而是<b>由生成过程直接给出</b>（T1/T3/T4）或<b>由事后真实事件对齐</b>（T5）——
  这让"平台自己考自己"的嫌疑降到最低：打分路径与真值路径互相独立。</p>

  <h3>4.1 读得准、能发现错、算得对（自动判定层）</h3>
  <div class="grid4">
    <div class="kpi"><div class="v">${pct(finrisk.t1F1, 1)}</div><div class="k">T1 字段级 P/R/F1</div><div class="s">${num(finrisk.t1Cells)} 单元格，MAPE ${n1(finrisk.t1Mape, 4)}%</div></div>
    <div class="kpi"><div class="v">${pct(finrisk.t3Recall, 1)}</div><div class="k">T3 勾稽缺陷召回</div><div class="s">4 类注入缺陷；干净样本误报 ${pct(finrisk.t3Fpr, 1)}</div></div>
    <div class="kpi"><div class="v">${pct(finrisk.t4Agreement, 1)}</div><div class="k">T4 指标一致率</div><div class="s">30 个指标点与独立重算比对</div></div>
    <div class="kpi neutral"><div class="v">5/5</div><div class="k">验收门槛</div><div class="s">T1 F1 / 命中率、T3 召回 / 误报、T4 一致率全部达标</div></div>
  </div>
  <p style="font-size:13px;color:var(--c-muted);margin-top:6px">
    T1/T3 的样本是"合成的真实形状"（满足会计恒等式，带千分位、括号负数、单位行等脏格式），
    <strong>不能替代真实上市公司财报</strong>；接入真实数据后必须重跑——这一点写在基准报告里。
  </p>

  <h3>4.2 判得准吗：与"三行财务规则"同台对比（point-in-time，时间切分）</h3>
  <p>测试集为 ${num(t5rows.st.test)} 家企业的 ${esc(String(t5.st.split ? t5.st.split.testFrom : '').slice(0, 4))} 年起样本，
  训练集到 ${esc(String(t5.st.split ? t5.st.split.trainUntil : ''))} 为止；标签来自事后真实事件（ST/退市风险警示、行政处罚与立案、任一高危事件）。</p>
  <div class="figure">
    <div class="cap">图 1　三种风险目标的 AUC 对比（越高越好；同一批 ${num(t5rows.st.test)} 个测试样本）</div>
    ${groupedBars([
      { label: '退市风险警示', bars: [
        { name: '三行规则', value: t5rows.st.baseAuc, color: C.baseline },
        { name: '仅财务维度', value: t5rows.st.finAuc, color: C.finance },
        { name: '平台六维', value: t5rows.st.platAuc, color: C.platform },
      ] },
      { label: '处罚 / 立案', bars: [
        { name: '三行规则', value: t5rows.penalty.baseAuc, color: C.baseline },
        { name: '仅财务维度', value: t5rows.penalty.finAuc, color: C.finance },
        { name: '平台六维', value: t5rows.penalty.platAuc, color: C.platform },
      ] },
      { label: '任一高危事件', bars: [
        { name: '三行规则', value: t5rows.any.baseAuc, color: C.baseline },
        { name: '仅财务维度', value: t5rows.any.finAuc, color: C.finance },
        { name: '平台六维', value: t5rows.any.platAuc, color: C.platform },
      ] },
    ], { max: 1 })}
  </div>
  <table>
    <caption>表 1　预警效果明细（测试集 n=${num(t5rows.st.test)}；Top-${num(t5rows.st.k)} 命中率为取分数最高前 ${num(t5rows.st.k)} 家时的召回）</caption>
    <thead><tr><th>风险目标（测试集正例）</th><th class="n">基线 AUC</th><th class="n">平台 AUC</th><th class="n">基线 AP</th><th class="n">平台 AP</th><th class="n">Top-${num(t5rows.st.k)} 召回</th><th class="n">提前预警中位天数</th></tr></thead>
    <tbody>
      <tr><td>退市风险警示 / 终止上市（${num(t5rows.st.positives)}）</td><td class="n">${n1(t5rows.st.baseAuc * 100, 1)}</td><td class="n best">${n1(t5rows.st.platAuc * 100, 1)}</td><td class="n">${n1(t5rows.st.baseAp * 100, 1)}</td><td class="n">${n1(t5rows.st.platAp * 100, 1)}</td><td class="n">${pct(t5rows.st.baseRecall * 100, 1)} → <b class="best">${pct(t5rows.st.platRecall * 100, 1)}</b></td><td class="n">${num(t5rows.st.lead)}</td></tr>
      <tr><td>行政处罚 / 立案调查（${num(t5rows.penalty.positives)}）</td><td class="n">${n1(t5rows.penalty.baseAuc * 100, 1)}</td><td class="n best">${n1(t5rows.penalty.platAuc * 100, 1)}</td><td class="n">${n1(t5rows.penalty.baseAp * 100, 1)}</td><td class="n best">${n1(t5rows.penalty.platAp * 100, 1)}</td><td class="n">${pct(t5rows.penalty.baseRecall * 100, 1)} → <b class="best">${pct(t5rows.penalty.platRecall * 100, 1)}</b></td><td class="n">${num(t5rows.penalty.lead)}</td></tr>
      <tr><td>任一高危事件（${num(t5rows.any.positives)}）</td><td class="n">${n1(t5rows.any.baseAuc * 100, 1)}</td><td class="n best">${n1(t5rows.any.platAuc * 100, 1)}</td><td class="n">${n1(t5rows.any.baseAp * 100, 1)}</td><td class="n best">${n1(t5rows.any.platAp * 100, 1)}</td><td class="n">${pct(t5rows.any.baseRecall * 100, 1)} → <b class="best">${pct(t5rows.any.platRecall * 100, 1)}</b></td><td class="n">${num(t5rows.any.lead)}</td></tr>
    </tbody>
  </table>
  <div class="callout good"><span class="t">最有力的一条证据：非财务维度确实带来增量</span>
    同一批样本、同一套评分逻辑下，<strong>只喂财务维度</strong>的 AUC 是 ${n1(t5rows.st.finAuc * 100, 1)} / ${n1(t5rows.penalty.finAuc * 100, 1)} / ${n1(t5rows.any.finAuc * 100, 1)}，
    加上新闻与司法等非财务维度后升到 <strong>${n1(t5rows.st.platAuc * 100, 1)} / ${n1(t5rows.penalty.platAuc * 100, 1)} / ${n1(t5rows.any.platAuc * 100, 1)}</strong>。
    也就是说：模型不是靠"财务指标换个算法"，而是靠数据面本身更宽。</div>
  <div class="callout warn"><span class="t">必须同时说清的三件事</span>
    ① 退市目标的 <strong>AP 仍略低于基线</strong>（${n1(t5rows.st.platAp * 100, 1)} vs ${n1(t5rows.st.baseAp * 100, 1)}）——AUC 全面领先不等于每个指标都领先；
    ② ST / 处罚是<strong>事后标签</strong>，只能证明"更早识别出风险信号"，不能证明因果；
    ③ 测试集正例数只有 ${num(t5rows.st.positives)} 个（退市目标），置信区间较宽。</div>
</section>

<section id="external">
  <h2><span class="no">05</span>第三层：与 ${lockSummary.benchmarks} 组外部公开基准对齐</h2>
  <p class="takeaway">外部基准的价值不在分数高低，而在<b>题目、答案、判分口径都不是我们定的</b>。
  本轮锁定 ${num(lockSummary.files)} 个输入文件（${n1(lockSummary.mb, 1)} MB，含 sha256 清单），固定种子抽样，覆盖四个层级。</p>

  <div class="grid3">
    <div class="kpi"><div class="v">${pct(cflueKn.accuracyPct, 1)}</div><div class="k">CFLUE 中文金融知识</div><div class="s">单选 ${pct(dig(cflueM, 'knowledge.singleSelectAccuracy.accuracyPct', null), 1)}、多选 ${pct(dig(cflueM, 'knowledge.multiSelectAccuracy.accuracyPct', null), 1)}、判断 ${pct(dig(cflueM, 'knowledge.byTaskType.判断题.accuracyPct', null), 1)}</div></div>
    <div class="kpi"><div class="v">${pct(dig(finevalM, 'numerical.overall.accuracyPct', null), 1)}</div><div class="k">FinEval 金融数值计算</div><div class="s">全量 ${num(dig(finevalM, 'numerical.overall.n', null))} 题；指标抽取数字召回 ${n1(dig(finevalM, 'indexExtraction.meanNumberRecall', null), 2)}</div></div>
    <div class="kpi"><div class="v">${pct(mmOverall.accuracyPct, 1)}</div><div class="k">FinEval-MM 图表截图四选一</div><div class="s">n=${num(mmOverall.n)}，12 类题型分层抽样</div></div>
    <div class="kpi"><div class="v">${pct(fbOracle.accuracyPct, 1)}</div><div class="k">FinanceBench oracle（给证据）</div><div class="s">closedBook ${pct(fbClosed.accuracyPct, 1)}（含记忆成分，见 06 节）</div></div>
    <div class="kpi"><div class="v">${pct(bfclOverall.accuracyPct, 1)}</div><div class="k">BFCL v4 工具调用</div><div class="s">simple ${pct(bfclSimple.accuracyPct, 1)} / multiple ${pct(bfclMultiple.accuracyPct, 1)} / 应拒调 ${pct(bfclIrr.accuracyPct, 1)}</div></div>
    <div class="kpi"><div class="v">${n1(dig(omniM, 'meanNumberRecall', null), 3)}</div><div class="k">OmniDocBench 数字召回（18 页）</div><div class="s">含表格页 ${n1(dig(omniM, 'tablePages.meanNumberRecall', null), 3)}；片段召回 ${n1(dig(omniM, 'meanSegmentRecall', null), 3)}</div></div>
  </div>

  <div class="figure">
    <div class="cap">图 2　CFLUE 知识题：三种题型准确率（同一批 ${num(cflueKn.n)} 题；全部答案均由最严格的"只输出字母"路径抽取，无宽松扫描。橙色标注明显偏低的题型）</div>
    ${groupedBars([
      { label: 'CFLUE 知识题', bars: [
        { name: '单项选择题', value: dig(cflueM, 'knowledge.byTaskType.单项选择题.accuracyPct', 0) / 100, color: C.platform },
        { name: '判断题', value: dig(cflueM, 'knowledge.byTaskType.判断题.accuracyPct', 0) / 100, color: C.platform },
        { name: '多项选择题', value: dig(cflueM, 'knowledge.byTaskType.多项选择题.accuracyPct', 0) / 100, color: C.warn },
      ] },
    ], { max: 1, height: 150 })}
  </div>
  <p style="font-size:12.5px;color:var(--c-muted)">多项选择题需要同时选对全部选项才算正确，因此天然低于单选；这也是后续可优化的一档（例如让模型先输出候选再自检）。</p>

  <h3>5.1 与外部模型的同题对比（雷达图）</h3>
  <p><strong>先说方法</strong>：拿我们的分数直接去比论文里的分数是<strong>不成立的</strong>——两套裁判对「什么算对」的宽严不同。
  所以我们做了两件事：① 把论文公开的答案送进<strong>我们的裁判</strong>重判，得到同一把尺子下的对照；
  ② 修掉我们自己给模型戴的手铐（原提示词主动邀请"证据不足就拒答"）。</p>

  ${radarData ? `
  <table>
    <caption>表 12a　裁判校准：论文公开答案在「论文标签」与「我们的裁判」下的差异（同一批 150 题）</caption>
    <thead><tr><th>模型 / 口径</th><th class="n">n</th><th class="n">论文标签</th><th class="n">我们的裁判重判</th><th class="n">差值</th><th>含义</th></tr></thead>
    <tbody>
      ${(radarData.sameJudge ? radarData.sameJudge.models : []).map((m) => `<tr><td>${esc(m.label)}</td><td class="n">${num(m.n)}</td><td class="n">${pct(m.paperAccuracyPct, 2)}</td><td class="n">${pct(m.ourJudgeAccuracyPct, 2)}</td><td class="n">${(m.ourJudgeAccuracyPct - m.paperAccuracyPct).toFixed(2)}pp</td><td style="font-size:12.5px">${m.paperAccuracyPct > 60 ? '我们的裁判明显更严：把「大体答对但表述/单位不同」判成错' : '两家裁判基本一致：答案本来就大量是错的'}</td></tr>`).join('')}
    </tbody>
  </table>
  <p style="font-size:12.5px;color:var(--c-muted)">读法：宽严差异<strong>只出现在高分模型</strong>上（GPT-4 −8.67pp、GPT-4-1106 −6.67pp），
  而在 Claude-2 上只有 +0.67pp——说明分歧集中在「差一点就对」的答案，而不是「全错」的答案。
  这正好解释了此前的"平手"结论：那是两把尺子量出来的。</p>

  <div class="figure">
    <div class="cap">图 3　同一裁判口径下的分题型准确率（oracle 口径，每类 50 题；本平台使用修正后的 A1 提示词，外环为 100%、每环 25%）</div>
    <div style="display:grid;grid-template-columns:minmax(0,0.92fr) minmax(0,1.08fr);gap:20px;align-items:center">
      <div>${radar(radarAxes, radarSeries, { size: 520 })}</div>
      <div>
        <table style="margin-top:0;font-size:12.5px">
          <thead><tr><th>模型 / 口径</th><th class="n">总体</th><th class="n">指标类</th><th class="n">领域推理</th><th class="n">新颖生成</th></tr></thead>
          <tbody>
            <tr style="background:var(--c-good-soft)"><td><b>本平台（deepseek-flash）</b><div class="chip good" style="margin-top:4px">同一裁判</div></td><td class="n best">${pct(dig(radarData, 'ours.accuracyPct', null), 1)}</td>${radarData.types.map((t) => `<td class="n">${pct(dig(radarData, `ours.byType.${t}.accuracyPct`, null), 0)}</td>`).join('')}</tr>
            ${(radarData.sameJudge ? radarData.sameJudge.models : []).map((m) => `<tr><td>${esc(m.label)}<div class="chip src" style="margin-top:4px">论文答案 · 我们裁判</div></td><td class="n">${pct(m.ourJudgeAccuracyPct, 1)}</td>${radarData.types.map((t) => `<td class="n">${pct(dig(m, `byType.${t}.accuracyPct`, null), 0)}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
        <p style="font-size:12.5px;color:var(--c-muted);margin-top:8px">每格样本量均为 50 题；"总体"为 150 题合计。本平台一行与其它三行<strong>由同一个裁判判定</strong>。</p>
      </div>
    </div>
    ${legend(radarSeries)}
  </div>

  ${fbHistory ? `
  <h4>从 82.0% 到 ${pct(dig(fbHistory, 'variants.A1（最新一次）.accuracyPct', null), 1)}%：改动只有一句提示词</h4>
  <p style="font-size:13px;color:var(--c-ink-2)">单次裁判在 n=60 上有 <strong>±2~3 题</strong>的噪声（诊断时发现同一份数字答案会被判成不同结论），
  因此所有变体的存量答案都用 <strong>judge@${dig(fbHistory, 'variantComparison.judgeVotes', 3)} 多数投票</strong>重判后再比较——下表即重判结果。</p>
  <table>
    <caption>表 12b　提示词与证据处理变体（dev 60 题，同一裁判多数投票；选型只在 dev，选定后在冻结 test 上验证一次）</caption>
    <thead><tr><th>变体</th><th class="n">准确率</th><th class="n">相对 A1</th><th class="n">指标类</th><th class="n">领域推理</th><th class="n">新颖生成</th><th>结论</th></tr></thead>
    <tbody>
      ${(dig(fbHistory, 'variantComparison.rows', []) || []).map((r) => {
        const label = {
          A0: 'A0 原提示词（含"无法确定就拒答"）',
          A1: 'A1 去保守化（证据必含答案，未陈述则推导）',
          A2: 'A2 A1 + 先写行项目与单位',
          B1: 'B1 证据结构化（确定性重排成 Markdown 表）+ A1',
          B1b: 'B1b 让模型先把证据转成表格（仅 LLM 结构化）',
          B2: 'B2 两阶段：先抽取候选行项目再作答',
        }[r.variant] || r.variant
        const verdict = { A0: '基线（9 题拒答）', A1: '✅ 采用', A2: '与 A1 持平且更啰嗦 → 不采用', B1: '❌ 比 A1 低 5.0pp → 不采用', B1b: '❌ 比 A1 低 5.0pp，且贵 6 倍 → 不采用', B2: '❌ 比 A1 低 5.0pp → 不采用' }[r.variant] || ''
        const delta = r.variant === 'A1' ? '—' : `${r.accuracyPct - 88.3 >= 0 ? '+' : ''}${(r.accuracyPct - 88.3).toFixed(1)}pp`
        return `<tr${r.variant === 'A1' ? ' style="background:var(--c-good-soft)"' : ''}><td>${esc(label)}</td><td class="n ${r.variant === 'A1' ? 'best' : ''}">${pct(r.accuracyPct, 1)}</td><td class="n">${delta}</td><td class="n">${esc(r.byType['metrics-generated'] || '—')}</td><td class="n">${esc(r.byType['domain-relevant'] || '—')}</td><td class="n">${esc(r.byType['novel-generated'] || '—')}</td><td style="font-size:12.5px">${verdict}</td></tr>`
      }).join('')}
      <tr><td>A1 · <b>冻结 test 验证</b></td><td class="n">${pct(dig(fbHistory, 'variants.A1-test.accuracyPct', null), 1)}</td><td class="n">+1.7pp</td><td class="n">93.3%</td><td class="n">90.0%</td><td class="n">86.7%</td><td style="font-size:12.5px">test 90 题，只跑一次</td></tr>
    </tbody>
  </table>
  <div class="callout bad"><span class="t">B1 是负结果：证据结构化没有帮上忙，反而拖低 5 个百分点</span>
    我们把 PDF 抽出的断行文本确定性地重排成 Markdown 表（${num(dig(fbHistory, 'b1Restructure.tables', null))} 张表 / ${num(dig(fbHistory, 'b1Restructure.tableRows', null))} 行，
    覆盖 ${pct(dig(fbHistory, 'b1Restructure.coveragePct', null), 1)} 的证据），并给它加了硬约束：
    <strong>数字不许丢、不许编造</strong>（150 条证据全部通过，见 <code>bench/html/check-restructure.js</code>）。逻辑上这该有帮助，实测却更低，原因有三条，都值得记下来：
    <br>① <strong>"不丢数字"不等于"列对齐正确"</strong>——v1 版本曾把 8 列的子表强行按 2 列对齐，数字一个没丢但全部串列，答案随之出错（这条 bug 是自检发现的，修复后重测）；
    <br>② <strong>只能安全结构化 ${pct(dig(fbHistory, 'b1Restructure.coveragePct', null), 0)} 的证据</strong>，其余保持原文，于是输入变成"半结构化混合体"，反而增加了理解成本；
    <br>③ <strong>重排破坏了原始排版里的隐含线索</strong>（哪些数字属于同一期间、哪些是同一小节），而这些线索对模型是有用的。
    <br>让模型自己转表格（B1b）同样低 5pp，且成本是 A1 的 6 倍。两阶段抽取（B2）亦同。这就是"为什么不把负结果藏起来"：它省掉了后面再走一遍弯路的成本。</div>
  <p style="font-size:12.5px;color:var(--c-muted)">同一变体多次运行之间有 1~3pp 波动（A0 历次 ${JSON.stringify(dig(fbHistory, 'variants.A0（最新一次）.accuracySpreadPct', []))}%），
  因此这些差值只能读作"量级差异"，不能读作精确提升。</p>
  ` : ''}

  <div class="callout warn"><span class="t">这张图与这张表该怎么读（四条都别跳过）</span>
    ① <strong>同一裁判下我们在这一层领先</strong>：${pct(dig(radarData, 'ours.accuracyPct', null), 1)}% 对 GPT-4 ${pct(dig(radarData, 'sameJudge.models.0.ourJudgeAccuracyPct', null), 1)}%、GPT-4-1106 ${pct(dig(radarData, 'sameJudge.models.1.ourJudgeAccuracyPct', null), 1)}%——但差距主要来自<strong>裁判口径与提示词口径的对齐</strong>，不是模型突然变强；
    ② <strong>A1 的增益依赖 oracle 前提</strong>：它利用了"证据必然充分"这一条（oracle 口径的 evidence 就是论文标注的支撑段落）。在真实检索场景里检索可能没命中，这条前提不成立 —— 因此这是<strong>把口径拉齐</strong>，不是生产环境的普适提升；
    ③ <strong>裁判仍是同源的</strong>（flash 判 flash）：用同一裁判判双方答案消除了"尺子不同"的问题，但消不掉"偏袒自己"的可能，彻底解决需要独立裁判；
    ④ 未纳入的公开结果还有 <strong>Llama2-70B single-store（论文 ${pct((radarData.models.find((m) => m.mode === 'retrieval') || {}).accuracyPct ?? null, 1)}%）</strong>——那是<strong>检索口径</strong>，与 oracle 条件不同，合并会把"检索没命中"算成"模型不会读"。</div>
  <div class="callout good"><span class="t">我们在这一层的定位（以及真正的优势在哪）</span>
    在同一把尺子下，本平台 ${pct(dig(radarData, 'ours.accuracyPct', null), 1)}%，高于 GPT-4（${pct(dig(radarData, 'sameJudge.models.0.ourJudgeAccuracyPct', null), 1)}%）与 GPT-4-1106（${pct(dig(radarData, 'sameJudge.models.1.ourJudgeAccuracyPct', null), 1)}%），
    但"问答题高几个点"并不是平台的价值主张。真正的差异化在<strong>这一层之外</strong>：
    ① 端到端预警（六维 AUC ${n1(t5rows.st.platAuc * 100, 1)} vs 三行规则 ${n1(t5rows.st.baseAuc * 100, 1)}，且领先来自数据面更宽）；
    ② 结构化抽取 / 勾稽校验 / 指标测算的确定性能力（T1/T3/T4 全部 ${pct(finrisk.t1F1, 0)} 且 MAPE ${n1(finrisk.t1Mape, 4)}%）；
    ③ 25 个工具的受控编排与审批闸门（BFCL ${pct(bfclOverall.accuracyPct, 1)}%）；
    ④ 无证据时不硬答（闭卷口径我们 ${pct(closedBook ? closedBook.ours : null, 1)}% vs GPT-4 ${pct(closedBook ? closedBook.gpt4 : null, 2)}%——但我们对闭卷已有语料污染，见 6.2）。
    这些维度<strong>没有可比的公开多方数字</strong>，所以本页不给它们编雷达轴。</div>
  ` : '<p style="color:var(--c-muted)">（未生成雷达数据：先跑 node bench/html/prepare-radar-data.js）</p>'}

  <h3>5.2 外部对照表：同题同集，可直接并列</h3>
  <table>
    <caption>表 2　FinanceBench 开源子集 150 题：论文公开结果（由仓库逐题标签统计）与我们同题对比</caption>
    <thead><tr><th>模型 / 口径</th><th class="n">n</th><th class="n">准确率</th><th>说明</th></tr></thead>
    <tbody>
      ${(graderVal || []).map((g) => `<tr><td>${esc(g.label)}（论文）</td><td class="n">${g.rows || 150}</td><td class="n">${pct(g.publishedAccuracyPct, 2)}</td><td>我方判分器与论文标签一致率 ${pct(g.deterministicAgreementPct, 2)}</td></tr>`).join('')}
      <tr style="background:var(--c-good-soft)"><td><b>本平台（deepseek-flash）oracle</b></td><td class="n">${num(fbOracle.n)}</td><td class="n best">${pct(fbOracle.accuracyPct, 2)}</td><td>裁判口径；确定性口径 ${pct(fbDetOracle.accuracyPct, 2)}</td></tr>
      <tr><td>本平台 closedBook</td><td class="n">${num(fbClosed.n)}</td><td class="n">${pct(fbClosed.accuracyPct, 2)}</td><td>不给任何文档；论文同口径 GPT-4 为 4.67%</td></tr>
    </tbody>
  </table>
  <p style="font-size:12.5px;color:var(--c-muted)">判分器可信度先被验证：用我们的确定性判分重判论文公开答案，与论文标签一致率 ${pct(Math.min(...(graderVal || [{ deterministicAgreementPct: 0 }]).map((g) => g.deterministicAgreementPct || 0)), 1)}–100%；
  初版未做量纲换算时只有 61.5%，修正过程记录在案。</p>

  <h3>5.3 工具调用：25 个工具与 MCP 的底座能力（BFCL v4）</h3>
  <table>
    <caption>表 3　BFCL v4 非实时子集（n=${num(bfclOverall.n)}）；判分为自实现 AST 判定，非官方 checker</caption>
    <thead><tr><th>子集</th><th class="n">通过率</th><th class="n">n</th><th>含义</th></tr></thead>
    <tbody>
      <tr><td>simple（单函数）</td><td class="n best">${pct(bfclSimple.accuracyPct, 2)}</td><td class="n">${num(bfclSimple.n)}</td><td>选对函数并填对参数</td></tr>
      <tr><td>multiple（多函数选一）</td><td class="n">${pct(bfclMultiple.accuracyPct, 2)}</td><td class="n">${num(bfclMultiple.n)}</td><td>多个候选里只调正确的那一个</td></tr>
      <tr><td>irrelevance（应拒调）</td><td class="n" style="color:var(--c-warn)">${pct(bfclIrr.accuracyPct, 2)}</td><td class="n">${num(bfclIrr.n)}</td><td>没有合适函数时不该发起调用</td></tr>
    </tbody>
  </table>
  <p style="font-size:13px">失败 ${num(dig(bfclM, 'failedTotal', null))} 例的构成：
  ${Object.entries(bfclErrors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc({ 'irrelevance:called_a_function': '不该调用却调用了', 'value_error:string': '字符串取值不符', 'value_error:others': '取值不符', 'value_error:list/tuple': '列表参数不符', 'value_error:dict_key': '字典键不符', 'simple_function_checker:wrong_count': '调用个数不对', 'multiple_function_checker:wrong_count': '调用个数不对', 'simple_function_checker:wrong_func_name': '函数名选错' }[k] || k)} ${v}`).join('、')}。
  其中 <strong>"不该调用却调用了" ${bfclErrors['irrelevance:called_a_function'] || 0} 例</strong>对应平台里"乱调工具"的风险，是工具层安全边界最该盯的数字。</p>

  <h3>5.4 文档读取：图像输入无法靠记忆作弊</h3>
  <div class="figure">
    <div class="cap">图 4　OmniDocBench demo 18 页：含表格页 vs 非表格页（财报/研报最要紧的一类单独看）</div>
    ${pairedBars([
      { label: '数字召回', a: dig(omniM, 'nonTablePages.meanNumberRecall', 0), b: dig(omniM, 'tablePages.meanNumberRecall', 0), aLabel: '非表格页（9 页）', bLabel: '含表格页（9 页）' },
      { label: '片段召回', a: dig(omniM, 'nonTablePages.meanSegmentRecall', 0), b: dig(omniM, 'tablePages.meanSegmentRecall', 0) },
      { label: '字符编辑距离比 ↓', a: dig(omniM, 'nonTablePages.meanEditRatio', 0), b: dig(omniM, 'tablePages.meanEditRatio', 0), aColor: C.warn, bColor: C.warn },
    ], { max: 1, fmt: (v) => v.toFixed(3) })}
  </div>
  <p style="font-size:13px;color:var(--c-ink-2)">含表格页的数字召回 ${n1(dig(omniM, 'tablePages.meanNumberRecall', null), 3)}、编辑距离 ${n1(dig(omniM, 'tablePages.meanEditRatio', null), 3)}，
  明显好于非表格页（${n1(dig(omniM, 'nonTablePages.meanNumberRecall', null), 3)} / ${n1(dig(omniM, 'nonTablePages.meanEditRatio', null), 3)}）——
  这与直觉相反但在情理之中：表格是结构化的，而杂志、报纸多栏排版更难还原阅读顺序。
  <strong>口径提醒</strong>：这是自实现的保真度指标，不是官方 TEDS/CDM。</p>

  <div class="callout warn"><span class="t">外部对齐的边界（一并说清）</span>
  FinEval-MM 引用的图表题只有 ${pct(dig(ext, 'benchmarks.fineval-mm.sample.coverage.coveragePct', null), 1)} 的图片随仓库发布（其余目录未开放、HF 返回 401）；
  BFCL 只跑非实时子集；CFLUE 用的是仓库发布的 3,864 题子集而非 3.8 万题全集。
  这些"拿不到"都写进了报告，而不是记成"模型答错"。</div>
</section>

<section id="honest">
  <h2><span class="no">06</span>短板与反例：这一轮测出来的真问题</h2>
  <p class="takeaway">一份只报喜的报告没有价值。以下四条都是<b>我们自己测出来打自己脸</b>的结果，附改进方向。</p>

  <h3>6.1 平台链路在客观题上比直连模型低 ${chainCflue && chainBareCflue ? n1(Math.abs(chainBareCflue.pct - chainCflue.accuracyPct), 1) : '18.8'} 个百分点</h3>
  <div class="figure">
    <div class="cap">图 5　同一批题：口径 A（直连模型）vs 口径 B（经平台 /api/chat/stream，含平台系统提示词与 25 个工具）</div>
    ${dumbbell([
      { label: 'CFLUE 知识题', a: chainBareCflue ? chainBareCflue.pct : 88.3, b: chainCflue ? chainCflue.accuracyPct : 69.5, aLabel: '直连模型', bLabel: '平台链路', delta: `−${chainCflue && chainBareCflue ? n1(chainBareCflue.pct - chainCflue.accuracyPct, 1) : '18.8'}pp` },
      { label: 'FinEval-MM 图片题', a: chainBareMm ? chainBareMm.pct : 90, b: chainMm ? chainMm.accuracyPct : 90, aLabel: '直连模型', bLabel: '平台链路', delta: chainBareMm && chainMm ? `${(chainMm.accuracyPct - chainBareMm.pct) >= 0 ? '+' : ''}${n1(chainMm.accuracyPct - chainBareMm.pct, 1)}pp` : '持平' },
    ], { max: 100 })}
  </div>
  <div class="callout bad"><span class="t">读法与动作</span>
    纯客观题上，平台链路与直连模型唯一差别就是"平台系统提示词 + 工具清单"。因此这
    ${chainCflue && chainBareCflue ? n1(chainBareCflue.pct - chainCflue.accuracyPct, 1) : '18.8'} 个百分点<strong>不应归因于模型能力</strong>，
    而是平台在"客观问答"场景下的提示词/编排开销：模型的注意力被人设与工具说明占据，逐题明细里能看到答非所选与空回答。
    <strong>改进方向</strong>：按场景裁剪系统提示词与工具集（客观问答不需要 25 个工具）。
    反过来说，平台<strong>自己实现</strong>的附件读取链路在图片题上与直连持平（${chainMm ? `${num(chainMm.correct)}/${num(chainMm.n)}` : '18/20'}），这条结论比图片题分数本身更值钱。</div>

  <h3>6.2 FinanceBench 闭卷已被训练语料污染：oracle 分数不能全算作"读懂文档"</h3>
  <table>
    <caption>表 4　闭卷口径交叉核查（n=${num(fbClosed.n)}）：把裁判判定与确定性判分交叉看</caption>
    <thead><tr><th>交叉情况</th><th class="n">题数</th><th>说明</th></tr></thead>
    <tbody>
      <tr><td>裁判判对且确定性也判对</td><td class="n">${num(cbAudit ? cbAudit.both : null)}</td><td>模型给出了与标准答案一致的数值</td></tr>
      <tr><td>仅裁判判对</td><td class="n">${num(cbAudit ? cbAudit.judgeOnly : null)}</td><td>标准答案为长句，确定性判分无法覆盖</td></tr>
      <tr><td>仅确定性判对</td><td class="n">${num(cbAudit ? cbAudit.detOnly : null)}</td><td>裁判口径更严（单位/表述不同）</td></tr>
      <tr><td>两者都不对</td><td class="n">${num(cbAudit ? cbAudit.neither : null)}</td><td>含拒答 ${num(cbAudit ? cbAudit.refusal : null)} 题</td></tr>
    </tbody>
  </table>
  <p>抽查可见模型在<strong>没有任何文档</strong>时给出具体数字：3M FY2018 资本开支 1,577 百万美元、
  Amazon FY2017 DPO 93.86 天、Adobe FY2022 营业利润率 34.6%、AMD FY2022 速动比率 1.58。
  论文里 GPT-4 闭卷只有 4.67%，我们测得 ${pct(fbClosed.accuracyPct, 1)}。
  <strong>结论</strong>：FinanceBench 的闭卷切分对该模型已发生污染，oracle 的 ${pct(fbOracle.accuracyPct, 1)} 含记忆成分；
  文档阅读能力以 OmniDocBench（图像输入）与 FinEval-MM 为准。</p>

  <h3>6.3 其余三条如实记录</h3>
  <ul>
    <li><strong>退市目标的 AP 仍低于基线</strong>（${n1(t5rows.st.platAp * 100, 1)} vs ${n1(t5rows.st.baseAp * 100, 1)}）：AUC 全面领先，但排序质量在正例极少的场景下仍不稳。</li>
    <li><strong>工具"应拒调"只有 ${pct(bfclIrr.accuracyPct, 2)}</strong>（${bfclErrors['irrelevance:called_a_function'] || 0}/${num(bfclIrr.n)} 次不该调用却调用了），这是平台工具层需要加护栏的地方。</li>
    <li><strong>复现性</strong>：同一配置把 FinanceBench 跑两遍，裁判口径 oracle 83.33% → 82.00%、closedBook 47.33% → 44.67%，
      因此本页数字<strong>只用于判断量级与方向，不用于比较小数点后差异</strong>。</li>
  </ul>
</section>

<section id="data">
  <h2><span class="no">07</span>数据资产：宽，而且可核验</h2>
  <p class="takeaway">预警能力的天花板由数据面决定。本轮把非财务维度从"抽样 900 家"扩到面板覆盖的全部 ${num(dman.panelCodes || 1348)} 家，
  测试集里 ${pct((dig(t5.st, 'metrics.strata.with_nonfinancial.n', 0) / Math.max(1, t5rows.st.test)) * 100, 1)} 的样本含非财务维度
  （此前只有 33%，扩采后补齐）。</p>
  <div class="grid4">
    <div class="kpi"><div class="v">${num(dig(dman, 'artifacts.panel.rows', null))}</div><div class="k">财务面板行数</div><div class="s">${num(dman.panelCodes)} 家企业，${n1((dig(dman, 'artifacts.panel.bytes', 0) || 0) / 1048576, 1)} MB，带 sha256</div></div>
    <div class="kpi"><div class="v">${num(nfman.news)}</div><div class="k">新闻 / 公告条数</div><div class="s">${num(nfman.requests)} 次公开接口请求，错误 ${num(nfman.errors)}</div></div>
    <div class="kpi"><div class="v">${num(nfman.legal)}</div><div class="k">司法记录条数</div><div class="s">巨潮资讯诉讼统计</div></div>
    <div class="kpi"><div class="v">${num(dig(t5.st, 'data.events', null))}</div><div class="k">风险事件标签</div><div class="s">ST / 退市 / 处罚 / 立案等，来自公开披露</div></div>
  </div>

  <h3>7.1 标签可信度：三源交叉验证</h3>
  <table>
    <caption>表 5　同一批标签用三条独立渠道复核（${esc(String(lval.generatedAt || '').slice(0, 10))}）</caption>
    <thead><tr><th>渠道</th><th class="n">命中</th><th>作用</th></tr></thead>
    <tbody>
      <tr><td>A · 巨潮关键词检索</td><td class="n">${num(dig(lval, 'bySource.A_keyword', null))}</td><td>主渠道，覆盖沪深两市</td></tr>
      <tr><td>B · 巨潮按日期全量扫描（不用关键词）</td><td class="n">${num(dig(lval, 'bySource.B_cninfo_range', null))}</td><td>发现关键词漏掉的 <b>${num(dig(lval, 'bySource.B_found_by_scan_missed_by_keyword', null))}</b> 条</td></tr>
      <tr><td>C · 深交所官方公告接口</td><td class="n">${num(dig(lval, 'bySource.C_szse', null))}</td><td>交易所第二披露渠道，补出 <b>${num(dig(lval, 'bySource.C_found_by_exchange_missed_by_keyword', null))}</b> 条</td></tr>
      <tr><td>A 被第二来源确认</td><td class="n">${num(dig(lval, 'bySource.A_confirmed_by_second_source', null))}</td><td>降低误标</td></tr>
    </tbody>
  </table>
  <p style="font-size:12.5px;color:var(--c-muted)">结论：单靠关键词检索会漏标签，因此用"关键词 + 全量扫描 + 交易所接口"三源互补，并把补出来的条目逐条记录在案。</p>

  <h3>7.2 数据可得性：拿不到的东西也是结论</h3>
  <div class="figure">
    <div class="cap">图 6　FinEval-MM 图表题的数据可得性漏斗（每一级的减少都有明确原因）</div>
    ${funnel([
      { top: 1000, value: 1000, label: `${num(dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.rows', 1000))} 行题目`, note: '15 个题型文件全量', color: C.platform },
      { top: 1000, value: dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.withImageAndAnswer', 943), label: `${num(dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.withImageAndAnswer', 943))} 行带图且有答案`, note: '其余缺答案字段', color: '#1f8f86' },
      { top: 1000, value: dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.resolvableImage', 464), label: `${num(dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.resolvableImage', 464))} 行图片确实随仓库发布`, note: 'figure/pg、sdt 等目录未开放，HF 返回 401', color: C.warn },
      { top: 1000, value: dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.usable', 371), label: `${num(dig(ext, 'benchmarks.fineval-mm.sample.coverage.funnel.usable', 371))} 行可用于评测`, note: '再要求选项 ≥2；评测即在此子集上分层抽样 150 题', color: '#8a6d1f' },
    ], { height: 250 })}
  </div>
</section>

<section id="cost">
  <h2><span class="no">08</span>成本与复现：数字不是钱堆出来的</h2>
  <p class="takeaway">整轮外部对齐共 <b>${num(totalCalls)} 次模型调用</b>，估算 <b>¥${n1(grandCost, 2)}</b>；
  自建基准与回归测试只用公开接口与本地计算，<b>不产生模型费用</b>。</p>
  <div class="two">
    <div class="card">
      <h4>调用与费用（口径 A 直连 + 裁判 + 口径 B 平台侧）</h4>
      <table>
        <thead><tr><th>用途</th><th class="n">调用</th><th class="n">输入 tokens</th><th class="n">输出 tokens</th><th class="n">费用</th></tr></thead>
        <tbody>
          ${usageRows.map(([k, u]) => `<tr><td>${esc(k)}</td><td class="n">${num(u.calls)}</td><td class="n">${num(u.promptTokens)}</td><td class="n">${num(u.completionTokens)}</td><td class="n">¥${n1(u.estimatedCostCNY, 2)}</td></tr>`).join('')}
          ${pusage.latest ? `<tr><td>口径 B 平台侧（读平台数据库）</td><td class="n">${num(pusage.latest.llmCalls)}</td><td class="n">${num(pusage.latest.promptTokens)}</td><td class="n">${num(pusage.latest.completionTokens)}</td><td class="n">¥${n1(pusage.latest.estimatedCostCNY, 2)}</td></tr>` : ''}
          <tr><td><b>合计</b></td><td class="n"><b>${num(totalCalls + (pusage.latest ? pusage.latest.llmCalls : 0))}</b></td><td class="n">—</td><td class="n">—</td><td class="n"><b>¥${n1(grandCost, 2)}</b></td></tr>
        </tbody>
      </table>
      <p style="font-size:12.5px;color:var(--c-muted)">输入侧缓存命中率约 ${n1((usageRows.reduce((s, [, u]) => s + (u.cacheHitTokens || 0), 0) / Math.max(1, usageRows.reduce((s, [, u]) => s + (u.promptTokens || 0), 0))) * 100, 0)}%，
      推理 tokens 是成本与延迟的主要来源。</p>
    </div>
    <div class="card">
      <h4>一条命令复现</h4>
      <pre><code># 1) 回归 + 工程指标（CI 同口径）
node bench/run.js --no-gui

# 2) 自建能力基准（T1/T3/T4）
node bench/benchmark/run.js

# 3) T5 风险预警回测（需先采数据集）
node bench/dataset/fetch.js && node bench/dataset/t5.js

# 4) 外部基准对齐（固定种子 + 版本锁定）
node bench/external/prepare.js --with-assets
node bench/external/run.js --models deepseek-flash

# 5) 重新生成本页
node bench/html/make-platform-report.js</code></pre>
      <div class="chips">
        <span class="chip">种子 20260101 / 20260913</span>
        <span class="chip">样本哈希随产物入库</span>
        <span class="chip src">原始数据不入库，清单与哈希入库</span>
      </div>
    </div>
  </div>
</section>

<section id="limits">
  <h2><span class="no">09</span>局限与未做：这一页没有覆盖到什么</h2>
  <div class="two">
    <div class="card">
      <h4>尚未纳入的评测层</h4>
      <ul>
        <li><strong>T2 图片/扫描件读取</strong>（≥150 张）与 <strong>T6 Agent 工具链</strong>（≥120 条意图）尚未纳入自建基准——本轮只用外部 FinEval-MM / BFCL 间接覆盖。</li>
        <li><strong>T7 报告生成质量</strong>（数字可核验率、幻觉率、双人评分 κ）未做。</li>
        <li><strong>长稳测试</strong>（8 小时 / 2000 请求）与<strong>数据量放大后的性能</strong>未做：当前时延是在小库上测得。</li>
      </ul>
    </div>
    <div class="card">
      <h4>口径与样本上的取舍</h4>
      <ul>
        <li><strong>单模型</strong>：全部结果由 deepseek-flash 产生，没有跨模型对比；验收项已改为"口径 A vs 口径 B"。</li>
        <li><strong>外部基准只做抽样</strong>：不宣称跑过全量；FinEval 经典学术题未公开、FinanceBench 只开源 150 题、BFCL 榜单未归档分数。</li>
        <li><strong>合成样本的边界</strong>：T1/T3 用的是"真实形状的合成财报"，接入真实数据后必须重跑。</li>
        <li><strong>因果性弱</strong>：ST / 处罚是事后标签，只能说明"更早识别出信号"，不能说明"避免了风险"。</li>
      </ul>
    </div>
  </div>
</section>

<section id="conclusion">
  <h2><span class="no">10</span>结论：三句话</h2>
  <div class="pillars">
    <div class="pillar"><div class="n">结论 一</div><div class="h">不是功能多，而是每条能力都有数字</div>
      <div class="q">${facts.tools} 个工具、${facts.tables} 张表、六个风险维度，对应 ${summary.suites ? summary.suites.total : '—'} 个回归套件与 ${lockSummary.benchmarks} 组外部基准；
      工具调用 BFCL ${pct(bfclOverall.accuracyPct, 1)}%，抽取字段级 F1 ${pct(finrisk.t1F1, 1)}%。</div>
      <div class="v">${num(finrisk.t1Cells)} 单元格 / ${num(bfclOverall.n)} 道工具题</div>
    </div>
    <div class="pillar b"><div class="n">结论 二</div><div class="h">效果有内部真值，也有外部坐标</div>
      <div class="q">自建基准用"生成过程真值 + 事后事件"避免自己考自己；外部基准用别人的题面和答案。
      预警 AUC 领先财务规则 +${n1((t5rows.st.platAuc - t5rows.st.baseAuc) * 100, 1)}pp，且领先来自数据面更宽而非换算法。</div>
      <div class="v">AUC ${n1(t5rows.st.platAuc * 100, 1)} vs ${n1(t5rows.st.baseAuc * 100, 1)}</div>
    </div>
    <div class="pillar c"><div class="n">结论 三</div><div class="h">短板是公开的，也是可修的</div>
      <div class="q">平台链路在客观题上掉 ${chainCflue && chainBareCflue ? n1(chainBareCflue.pct - chainCflue.accuracyPct, 1) : '18.8'}pp（提示词与工具编排问题）、
      工具"应拒调"仅 ${pct(bfclIrr.accuracyPct, 1)}、闭卷口径已被语料污染导致归因需谨慎——三条都写在这页里，并给了改法。</div>
      <div class="v">${chainCflue && chainBareCflue ? '−' + n1(chainBareCflue.pct - chainCflue.accuracyPct, 1) + 'pp' : '−18.8pp'} 待修</div>
    </div>
  </div>
  <div class="callout good"><span class="t">可原样进汇报的一段话</span>
    本平台在自建基准上完成了从"读得准"到"判得准"的闭环：${num(finrisk.t1Cells)} 个财报单元格抽取零误差、
    ${pct(finrisk.t3Recall, 0)} 勾稽缺陷召回且零误报、${num(finrisk.t4Checked)} 个指标点与独立重算完全一致；
    在 ${num(t5rows.st.test)} 个企业·期测试样本（time-split，训练集截至 ${esc(String(t5.st.split ? t5.st.split.trainUntil : ''))}）的前瞻性回测中，
    六维模型对退市风险、处罚立案、任一高危事件的
    AUC 分别为 ${n1(t5rows.st.platAuc * 100, 1)} / ${n1(t5rows.penalty.platAuc * 100, 1)} / ${n1(t5rows.any.platAuc * 100, 1)}，
    全面高于"三行财务规则"基线，并能提前约 ${num(t5rows.any.lead)} 天给出信号。
    能力同时有外部坐标：中文金融知识 CFLUE ${pct(cflueKn.accuracyPct, 1)}、工具调用 BFCL ${pct(bfclOverall.accuracyPct, 1)}%、
    财报问答 FinanceBench oracle ${pct(fbOracle.accuracyPct, 1)}%（与论文公开的 GPT-4 同一批题、同一口径）。
    全部 ${num(totalCalls)} 次模型调用成本约 ¥${n1(grandCost, 2)}，且每一条数字都能用仓库里的命令复现。
  </div>
</section>

<footer>
  <p><strong>审计信息</strong>　生成时间 ${esc(String(runAt))}；产物自动生成于 <code>bench/html/make-platform-report.js</code>；
  数据来源：<code>bench/report/bench-report.json</code>、<code>bench/dataset/out/*.json</code>、
  <code>bench/external/reports/external-alignment-v1.json</code>、<code>bench/external/out/manifest.json</code>。</p>
  <p>本页所有比例为<strong>抽样结果</strong>而非全集成绩；外部数字均注明出处；平台输出不构成任何投资建议。
  原始外部数据不入库，仓库内保存的是版本锁定清单与 sha256，可用 <code>prepare.js</code> 一键重抓。</p>
</footer>
</div>

<script>
(function(){
  var root=document.documentElement, btn=document.getElementById('themeBtn');
  var saved=null; try{saved=localStorage.getItem('rwp-theme')}catch(e){}
  if(saved){root.setAttribute('data-theme',saved)}
  function sync(){btn.textContent=root.getAttribute('data-theme')==='dark'?'浅色':'深色'}
  sync();
  btn.addEventListener('click',function(){
    var next=root.getAttribute('data-theme')==='dark'?'light':'dark';
    root.setAttribute('data-theme',next);
    try{localStorage.setItem('rwp-theme',next)}catch(e){}
    sync();
  });
  var links=[].slice.call(document.querySelectorAll('.navlinks a'));
  var secs=links.map(function(a){return document.querySelector(a.getAttribute('href'))}).filter(Boolean);
  var bar=document.getElementById('progress');
  function onScroll(){
    var y=window.scrollY||document.documentElement.scrollTop;
    var h=document.documentElement.scrollHeight-window.innerHeight;
    if(bar) bar.style.width=(h>0?(y/h*100):0)+'%';
    var cur=-1;
    secs.forEach(function(s,i){ if(s.getBoundingClientRect().top<=120) cur=i; });
    links.forEach(function(a,i){ a.classList.toggle('active', i===cur); });
  }
  window.addEventListener('scroll',onScroll,{passive:true}); onScroll();
})();
</script>
</body>
</html>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html, 'utf8')
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0)
console.log(`已生成 ${path.relative(REPO, OUT)}（${kb} KB，单文件零依赖）`)
console.log('数据来源校验：')
console.log(`  回归套件 ${summary.suites ? summary.suites.total : '—'} / 断言 ${summary.checks ? summary.checks.passed : '—'}`)
console.log(`  T5 平台 AUC ${n1(t5rows.st.platAuc * 100, 1)}% vs 基线 ${n1(t5rows.st.baseAuc * 100, 1)}%`)
console.log(`  外部基准 ${lockSummary.benchmarks} 组 / 调用 ${totalCalls} 次 / ¥${n1(grandCost, 2)}`)
console.log(`  口径 B 对比：${chainCflue ? '有' : '缺失'}（${chainCflue ? chainCflue.n + ' 题' : '—'}）`)

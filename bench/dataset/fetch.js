#!/usr/bin/env node
/**
 * bench/dataset/fetch.js —— T5 数据集采集管线（自动、可复现、带证据）
 *
 * 为什么这样做：人工翻公告效率低、偏差大；而"风险事件"在权威信源上是**有日期、有原文**的：
 *   · 巨潮资讯（交易所指定披露平台）公告全文检索 → 处罚/立案/退市风险警示/债务违约/被执行…
 *   · 东方财富 datacenter → 全市场财报面板（按代码取全部报告期，含披露日期）
 *
 * 产出（默认 bench/dataset/out/）：
 *   universe.jsonl  全 A 股清单（代码/名称/行业/上市日/是否 ST）
 *   events.jsonl    风险事件标签（类型/日期/标题/PDF 证据链接/命中关键词）
 *   panel.jsonl     财报面板（资产负债 + 利润表关键项，含报告期与披露日期）
 *   cohort.json     本次采集的队列（病例 = 现 ST；对照 = 分层随机抽样）
 *   manifest.json   参数、来源、条数、抓取时间、文件 sha256（口径留痕）
 *
 * 用法：
 *   node bench/dataset/fetch.js --cases 120 --controls 120 --since 2018-01-01
 *   node bench/dataset/fetch.js --events-only          # 只更新事件标签（快）
 *   node bench/dataset/fetch.js --panel-only --codes 002069,600518
 */
const crypto = require('node:crypto')
const dns = require('node:dns')
const fs = require('node:fs')
const path = require('node:path')

// 公开接口在 IPv6 链路上容易被对端直接关连接（踩过：universe 抓回 0 条）→ 优先走 IPv4
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}

const { EVENT_TYPES, classifyTitle } = require('./labels')

const argv = process.argv.slice(2)
const argOf = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const hasFlag = (f) => argv.includes(f)

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.resolve(REPO, argOf('--out', 'bench/dataset/out'))
const SINCE = argOf('--since', '2018-01-01')
const UNTIL = argOf('--until', new Date().toISOString().slice(0, 10))
const CASES = Number(argOf('--cases', '120'))
const CONTROLS = Number(argOf('--controls', '120'))
const PAGES_PER_KEYWORD = Number(argOf('--pages', '20'))
const SEED = Number(argOf('--seed', '20260913'))
const SLEEP_MS = Number(argOf('--sleep', '250'))
const REFRESH = hasFlag('--refresh')
const EVENTS_ONLY = hasFlag('--events-only')
const PANEL_ONLY = hasFlag('--panel-only')
const COHORT_ONLY = hasFlag('--cohort-only')
const EXTRA_CODES = argOf('--codes', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const nowIso = () => new Date().toISOString()

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const stats = { requests: 0, errors: [] }

async function getJson(url, { method = 'GET', body, headers, retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    stats.requests++
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': 'Mozilla/5.0 (rwp-bench dataset collector)', ...(headers || {}) },
        body,
      })
      if (res.status === 429 || res.status === 403) throw new Error(`HTTP ${res.status}（疑似限流）`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (!text.trim()) throw new Error('空响应（疑似限流）')
      return JSON.parse(text)
    } catch (err) {
      if (attempt === retries) {
        stats.errors.push({ url: url.slice(0, 120), error: String(err.message || err).slice(0, 120) })
        return null
      }
      // 退避：公开接口被限流时继续猛冲只会更糟
      await sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 300))
    }
  }
  return null
}

// ---------------------------------------------------------------- 1) 全 A 股清单
async function fetchUniverse() {
  const rows = []
  const fsParam = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' // 深主板/创业板/沪主板/科创板
  for (let pn = 1; pn <= 60; pn++) {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${fsParam}&fields=f12,f14,f13,f100,f26`
    const j = await getJson(url)
    const diff = j?.data?.diff || []
    if (!diff.length) break
    for (const d of diff) {
      rows.push({
        code: String(d.f12 || ''),
        name: String(d.f14 || ''),
        market: d.f13 === 1 ? 'SH' : 'SZ',
        industry: String(d.f100 || ''),
        listDate: d.f26 ? String(d.f26).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : '',
      })
    }
    if (diff.length < 100) break
    await sleep(SLEEP_MS)
  }
  // ST/*ST 直接从简称判定（交易所风险警示会在简称前加 ST/*ST）
  for (const r of rows) r.isST = /^\*?ST/.test(r.name) || /^S\*?ST/.test(r.name)
  return rows
}

// ---------------------------------------------------------------- 2) 风险事件标签（巨潮全文检索）
/**
 * 分年度窗口深翻页：单关键词命中动辄几千条（退市风险警示 6108、行政处罚 2941），
 * 只翻前几页会严重漏标签（踩过：队列里 120 只 ST 一条正例都没有）。
 * 按年切窗口后每个窗口只有几百条，能翻到底，且"每窗口抓到多少 / 窗口命中总数"可核对。
 */
async function harvestEvents(universeCodes) {
  const events = []
  const seen = new Set()
  const perKeyword = []
  // **增量合并**：按关键词分批抓时，不能把之前抓到的其它类型事件冲掉
  const eventsFile = path.join(OUT, 'events.jsonl')
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        const key = `${e.announcementId}:${e.type}`
        if (seen.has(key)) continue
        seen.add(key)
        events.push(e)
      } catch {}
    }
    console.log(`      （合并已有事件 ${events.length} 条）`)
  }
  const years = []
  const y0 = Number(SINCE.slice(0, 4))
  const y1 = Number(UNTIL.slice(0, 4))
  for (let y = y0; y <= y1; y++) years.push(y)

  const MAX_PAGES_PER_WINDOW = Number(argOf('--pages-per-window', '40'))
  // 关键词子集：全量 24 个词 × 9 个年度窗口 ≈ 20 分钟；试跑/迭代时用 --keywords 收敛
  const onlyKeywords = argOf('--keywords', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const rules = EVENT_TYPES.map((r) => ({
    ...r,
    keywords: onlyKeywords.length ? r.keywords.filter((k) => onlyKeywords.includes(k)) : r.keywords,
  })).filter((r) => r.keywords.length)

  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      let got = 0
      let totalSeen = 0
      for (const y of years) {
        const from = y === y0 ? SINCE : `${y}-01-01`
        const to = y === y1 ? UNTIL : `${y}-12-31`
        for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page++) {
          const body = new URLSearchParams({
            pageNum: String(page),
            pageSize: '30',
            column: 'szse',
            tabName: 'fulltext',
            plate: '',
            stock: '',
            searchkey: keyword,
            secid: '',
            category: '',
            trade: '',
            seDate: `${from}~${to}`,
            sortName: '',
            sortType: '',
            isHLtitle: 'true',
          }).toString()
          const j = await getJson('http://www.cninfo.com.cn/new/hisAnnouncement/query', {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          })
          const list = j?.announcements || []
          const total = j?.totalAnnouncement ?? 0
          if (page === 1) totalSeen += total
          if (!list.length) break
          for (const a of list) {
            const code = String(a.secCode || '')
            if (!universeCodes.has(code)) continue
            const title = String(a.announcementTitle || '').replace(/<[^>]+>/g, '')
            const hits = classifyTitle(title)
            const matched = hits.find((h) => h.keyword === keyword) || hits[0]
            if (!matched) continue
            const key = `${a.announcementId}:${matched.type}`
            if (seen.has(key)) continue
            seen.add(key)
            events.push({
              code,
              name: String(a.secName || ''),
              type: matched.type,
              severity: matched.severity,
              keyword: matched.keyword,
              date: a.announcementTime ? new Date(a.announcementTime).toISOString().slice(0, 10) : '',
              title,
              url: a.adjunctUrl ? `http://static.cninfo.com.cn/${a.adjunctUrl}` : '',
              announcementId: String(a.announcementId || ''),
              source: 'cninfo',
            })
            got++
          }
          if (page * 30 >= total) break
          await sleep(SLEEP_MS)
        }
        await sleep(SLEEP_MS)
      }
      perKeyword.push({ keyword, type: rule.type, added: got, windowHitsTotal: totalSeen })
      if (got) console.log(`      ${keyword}：+${got} 条（窗口命中合计 ${totalSeen}）`)
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { events, perKeyword }
}

// ---------------------------------------------------------------- 3) 财报面板（东财 datacenter）
const BALANCE_FIELDS = {
  TOTAL_ASSETS: 'total_assets',
  TOTAL_LIABILITIES: 'total_liabilities',
  TOTAL_EQUITY: 'equity',
  TOTAL_CURRENT_ASSETS: 'current_assets',
  TOTAL_CURRENT_LIAB: 'current_liabilities',
  INVENTORY: 'inventory',
  ACCOUNTS_RECE: 'accounts_receivable',
  MONETARYFUNDS: 'monetary_funds',
}
const INCOME_FIELDS = {
  TOTAL_OPERATE_INCOME: 'revenue',
  OPERATE_COST: 'operating_cost',
  PARENT_NETPROFIT: 'net_profit',
  DEDUCT_PARENT_NETPROFIT: 'deducted_profit',
}

async function emReport(reportName, code, extraFilter = '') {
  const filter = encodeURIComponent(`(SECURITY_CODE="${code}")${extraFilter}`)
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}&columns=ALL&pageSize=200&pageNumber=1&filter=${filter}&sortColumns=REPORT_DATE&sortTypes=-1`
  const j = await getJson(url)
  return j?.result?.data || []
}

async function fetchPanel(codes) {
  const panel = []
  for (const [i, code] of codes.entries()) {
    const balance = await emReport('RPT_DMSK_FN_BALANCE', code)
    await sleep(SLEEP_MS)
    const income = await emReport('RPT_LICO_FN_CPD', code)
    await sleep(SLEEP_MS)

    const byDate = {}
    for (const b of balance) {
      if (!b.REPORT_DATE) continue
      const d = String(b.REPORT_DATE).slice(0, 10)
      byDate[d] = byDate[d] || { code, name: b.SECURITY_NAME_ABBR || '', reportDate: d, industry: b.INDUSTRY_NAME || '' }
      for (const [src, dst] of Object.entries(BALANCE_FIELDS)) byDate[d][dst] = b[src] ?? null
      byDate[d].balanceSource = 'eastmoney:RPT_DMSK_FN_BALANCE'
    }
    for (const inc of income) {
      if (!inc.REPORTDATE) continue
      const d = String(inc.REPORTDATE).slice(0, 10)
      byDate[d] = byDate[d] || { code, name: inc.SECURITY_NAME_ABBR || '', reportDate: d }
      for (const [src, dst] of Object.entries(INCOME_FIELDS)) byDate[d][dst] = inc[src] ?? null
      if (inc.NOTICE_DATE) byDate[d].noticeDate = String(inc.NOTICE_DATE).slice(0, 10) // 披露日期：做 point-in-time 特征必须用
      byDate[d].incomeSource = 'eastmoney:RPT_LICO_FN_CPD'
    }
    panel.push(...Object.values(byDate))
    if ((i + 1) % 20 === 0) console.log(`    面板进度 ${i + 1}/${codes.length}`)
  }
  panel.sort((a, b) => (a.code === b.code ? (a.reportDate < b.reportDate ? -1 : 1) : a.code < b.code ? -1 : 1))
  return panel
}

// ---------------------------------------------------------------- 主流程
/** 写 JSONL：**空结果绝不覆盖已有好数据**（限流时最容易把辛苦抓的数据清零） */
function writeJsonl(file, rows, { protect = true } = {}) {
  const prev = fs.existsSync(file) ? fs.statSync(file).size : 0
  if (protect && rows.length === 0 && prev > 0) {
    stats.warnings = stats.warnings || []
    stats.warnings.push(`本次 ${path.basename(file)} 抓到 0 行，保留原有 ${prev} 字节文件（疑似限流）`)
    return { file: path.relative(REPO, file), rows: 0, bytes: prev, sha256: sha256(fs.readFileSync(file)), kept: true }
  }
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  fs.writeFileSync(file, text, 'utf8')
  return { file: path.relative(REPO, file), rows: rows.length, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const manifest = {
    generatedAt: nowIso(),
    since: SINCE,
    until: UNTIL,
    seed: SEED,
    params: { cases: CASES, controls: CONTROLS, pagesPerKeyword: PAGES_PER_KEYWORD, sleepMs: SLEEP_MS },
    sources: {
      universe: 'eastmoney push2 clist（沪深 A 股行情快照）',
      events: 'cninfo hisAnnouncement/query（巨潮资讯公告全文检索，交易所指定披露平台）',
      panel: 'eastmoney datacenter RPT_DMSK_FN_BALANCE + RPT_LICO_FN_CPD',
    },
    artifacts: {},
  }

  let universe = []
  const universeFile = path.join(OUT, 'universe.jsonl')
  const cached = fs.existsSync(universeFile)
    ? fs
        .readFileSync(universeFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  if (!PANEL_ONLY && (REFRESH || cached.length < 1000)) {
    console.log('[1/3] 抓取全 A 股清单…')
    universe = await fetchUniverse()
    console.log(`      ${universe.length} 只（其中 ST/*ST ${universe.filter((u) => u.isST).length} 只）`)
    manifest.artifacts.universe = writeJsonl(universeFile, universe)
  } else {
    universe = cached
    console.log(`[1/3] 复用已有全 A 股清单：${universe.length} 只（加 --refresh 可强制重抓）`)
    manifest.artifacts.universe = { file: path.relative(REPO, universeFile), rows: universe.length, reused: true }
  }
  const codeSet = new Set(universe.map((u) => u.code))
  if (!codeSet.size) {
    console.error('清单为空（信源疑似限流）：已保留原文件，本次中止以免污染数据集')
    process.exit(3)
  }

  // ---- 队列：病例 = 现 ST **或历史上出现过风险事件**；对照 = 分层随机抽样
  const casesFromEventsFlag = hasFlag('--cases-from-events')
  const eventCodes = new Set()
  const eventsFile = path.join(OUT, 'events.jsonl')
  if ((casesFromEventsFlag || true) && fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        if (e.code) eventCodes.add(e.code)
      } catch {}
    }
  }
  const caseMap = new Map()
  for (const u of universe.filter((x) => x.isST)) caseMap.set(u.code, { ...u, why: 'current-ST' })
  for (const code of eventCodes) {
    const u = universe.find((x) => x.code === code)
    if (u) caseMap.set(code, caseMap.get(code) || { ...u, why: 'past-event' })
    else caseMap.set(code, caseMap.get(code) || { code, name: '', industry: '', isST: false, why: 'past-event' })
  }
  const cases = [...caseMap.values()]
  const rnd = mulberry32(SEED)
  const pool = universe.filter((u) => !caseMap.has(u.code))
  const controls = []
  const picked = new Set()
  while (controls.length < CONTROLS && picked.size < pool.length) {
    const i = Math.floor(rnd() * pool.length)
    if (picked.has(i)) continue
    picked.add(i)
    controls.push(pool[i])
  }
  const selectedCases = cases.slice(0, CASES)
  const cohort = { cases: selectedCases, controls, extra: universe.filter((u) => EXTRA_CODES.includes(u.code)) }
  const cohortCodes = [...new Set([...selectedCases, ...controls, ...cohort.extra].map((u) => u.code))]
  fs.writeFileSync(path.join(OUT, 'cohort.json'), JSON.stringify({ ...cohort, seed: SEED, generatedAt: nowIso() }, null, 2))
  console.log(
    `[2/3] 队列：病例 ${selectedCases.length}（现 ST ${selectedCases.filter((c) => c.why === 'current-ST').length} / 历史事件 ${selectedCases.filter((c) => c.why === 'past-event').length}） + 对照 ${controls.length} + 指定 ${cohort.extra.length}`,
  )

  // ---- 事件标签
  if (!PANEL_ONLY && !COHORT_ONLY) {
    console.log(`[3/3] 抓取风险事件标签（${EVENT_TYPES.reduce((n, r) => n + r.keywords.length, 0)} 个关键词 × 最多 ${PAGES_PER_KEYWORD} 页）…`)
    const { events, perKeyword } = await harvestEvents(codeSet)
    const byType = {}
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1
    console.log(`      ${events.length} 条事件；分类：${JSON.stringify(byType)}`)
    manifest.artifacts.events = writeJsonl(path.join(OUT, 'events.jsonl'), events)
    manifest.perKeyword = perKeyword
    manifest.eventsByType = byType
  }

  // ---- 面板
  if (!EVENTS_ONLY && !COHORT_ONLY) {
    const codes = EXTRA_CODES.length && PANEL_ONLY ? EXTRA_CODES : cohortCodes
    console.log(`[面板] 抓取 ${codes.length} 只股票的财报面板…`)
    const panel = await fetchPanel(codes)
    console.log(`      ${panel.length} 条报告期记录`)
    manifest.artifacts.panel = writeJsonl(path.join(OUT, 'panel.jsonl'), panel)
    manifest.cohortCodes = codes.length
  }

  manifest.requests = stats.requests
  manifest.errors = stats.errors.slice(0, 20)
  manifest.warnings = (stats.warnings || []).slice(0, 20)
  // 局部运行（--cohort-only / --panel-only）不要抹掉上一次采集留下的口径信息
  const manifestFile = path.join(OUT, 'manifest.json')
  if (fs.existsSync(manifestFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      manifest.eventsByType = manifest.eventsByType || prev.eventsByType
      manifest.perKeyword = manifest.perKeyword || prev.perKeyword
      manifest.artifacts = { ...prev.artifacts, ...manifest.artifacts }
      if (manifest.artifacts.events && !manifest.eventsByType) manifest.eventsByType = prev.eventsByType
    } catch {}
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  console.log(`\n完成：${path.relative(REPO, OUT)}（请求 ${stats.requests} 次，失败 ${stats.errors.length} 次）`)
  for (const w of manifest.warnings) console.log(`  ⚠ ${w}`)
  console.log(`清单：${Object.entries(manifest.artifacts).map(([k, v]) => `${k}=${v.rows}行/${(v.bytes / 1024).toFixed(0)}KB`).join('  ')}`)
})()

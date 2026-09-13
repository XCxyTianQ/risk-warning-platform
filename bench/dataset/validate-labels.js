#!/usr/bin/env node
/**
 * bench/dataset/validate-labels.js —— B 档：标签三源交叉验证 + 人工复核队列
 *
 * 为什么要做：关键词检索必然漏（公告标题千变万化），单一信源也无法自证。
 * 这里用**三条相互独立的路径**给同一批标签做交叉验证：
 *
 *   源 A：巨潮**关键词检索**（现有标签来源，labels.js 词表）
 *   源 B：巨潮**按日期全量扫描**（不带关键词，本地按标题分类）→ 独立检索路径，能抓到关键词漏的
 *   源 C：**深交所官方公告接口**（深市股票的第二披露渠道，独立于巨潮）
 *
 * 输出：
 *   label-validation.json   各源覆盖、一致性、召回缺口、冲突清单
 *   review-queue.jsonl      需要人工复核的条目（单源、冲突、或仅源 A 命中）
 *
 * 置信度分级：A = ≥2 条独立路径确认；B = 1 条权威路径 + 证据链接；C = 无法确认（进复核队列）
 *
 * 用法：
 *   node bench/dataset/validate-labels.js [--months 12] [--data bench/dataset/out]
 */
const dns = require('node:dns')
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}
const fs = require('node:fs')
const path = require('node:path')

const { classifyTitle } = require('./labels')

const argv = process.argv.slice(2)
const argOf = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const REPO = path.resolve(__dirname, '..', '..')
const DATA = path.resolve(REPO, argOf('--data', 'bench/dataset/out'))
const WEEKS = Number(argOf('--weeks', '4'))
const SLEEP = Number(argOf('--sleep', '200'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench label validator)' }

async function cninfoRange(from, to, pageNum = 1, pageSize = 30) {
  const body = new URLSearchParams({
    pageNum: String(pageNum),
    pageSize: String(pageSize),
    column: 'szse',
    tabName: 'fulltext',
    plate: '',
    stock: '',
    searchkey: '',
    secid: '',
    category: '',
    trade: '',
    seDate: `${from}~${to}`,
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  }).toString()
  const res = await fetch('http://www.cninfo.com.cn/new/hisAnnouncement/query', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const j = await res.json().catch(() => null)
  return { total: j?.totalAnnouncement ?? 0, list: j?.announcements || [] }
}

/** 把一段时间窗口**翻到底**（覆盖对等才谈得上交叉验证） */
async function cninfoFullWindow(from, to, maxPages = 200) {
  const out = []
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    const r = await cninfoRange(from, to, page, 30)
    if (page === 1) total = r.total
    if (!r.list.length) break
    out.push(...r.list)
    if (page * 30 >= total) break
    await sleep(SLEEP)
  }
  return { total, list: out }
}

async function szseRange(from, to, pageNum = 1, pageSize = 30) {
  const res = await fetch('http://www.szse.cn/api/disc/announcement/annList?random=0.5', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json', Referer: 'http://www.szse.cn/disclosure/listed/notice/index.html' },
    body: JSON.stringify({ seDate: [from, to], channelCode: ['listedNotice_disc'], pageSize, pageNum }),
  })
  const j = await res.json().catch(() => null)
  // 深交所返回的是 recordCount / totalcount，不是 total（字段写错会导致只翻一页）
  const total = j?.announceCount ?? j?.recordCount ?? j?.totalcount ?? j?.total ?? (Array.isArray(j?.data) ? j.data.length : 0)
  return { total: Number(total) || 0, list: j?.data || [] }
}

async function szseFullWindow(from, to, maxPages = 60) {
  const out = []
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    const r = await szseRange(from, to, page, 30)
    if (page === 1) total = r.total
    if (!r.list.length) break
    out.push(...r.list)
    if (page * 30 >= total) break
    await sleep(SLEEP)
  }
  return { total, list: out }
}

/** 取最近 n 个"整周"窗口（覆盖对等、又能控制请求量） */
const weekWindows = (n) => {
  const out = []
  const end0 = new Date(Date.UTC(2026, 8, 1)) // 2026-09-01（避开当月不完整）
  for (let i = 1; i <= n; i++) {
    const end = new Date(end0.getTime() - (i - 1) * 7 * 86400000 - 86400000)
    const start = new Date(end.getTime() - 6 * 86400000)
    out.push([start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)])
  }
  return out
}

;(async () => {
  const eventsPath = path.join(DATA, 'events.jsonl')
  if (!fs.existsSync(eventsPath)) {
    console.error('缺少 events.jsonl：先跑 fetch.js')
    process.exit(2)
  }
  const events = fs
    .readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const windows = weekWindows(WEEKS)
  console.log(`=== 标签三源交叉验证（${events.length} 条标签，整周窗口 × ${windows.length} 个，窗口内全量翻页）===`)

  // ---- 源 B：巨潮按日期全量扫描（不带关键词，覆盖对等）
  const scanB = []
  const windowStats = []
  for (const [from, to] of windows) {
    const r = await cninfoFullWindow(from, to)
    let hits = 0
    for (const a of r.list) {
      const title = String(a.announcementTitle || '').replace(/<[^>]+>/g, '')
      const hs = classifyTitle(title)
      if (!hs.length) continue
      hits++
      scanB.push({
        code: String(a.secCode || ''),
        name: String(a.secName || ''),
        date: a.announcementTime ? new Date(a.announcementTime).toISOString().slice(0, 10) : '',
        title,
        types: hs.map((h) => h.type),
        source: 'cninfo-range',
      })
    }
    windowStats.push({ window: `${from}~${to}`, announcements: r.total, scanned: r.list.length, riskHits: hits })
    console.log(`  源 B ${from}~${to}：公告 ${r.total} 条（实扫 ${r.list.length}），命中风险 ${hits} 条`)
  }

  // ---- 源 C：深交所官方接口（覆盖对等）
  const scanC = []
  for (const [from, to] of windows) {
    const r = await szseFullWindow(from, to)
    let hits = 0
    for (const a of r.list) {
      const title = String(a.title || '').replace(/<[^>]+>/g, '')
      const hs = classifyTitle(title)
      if (!hs.length) continue
      hits++
      scanC.push({
        code: String(a.secCode || ''),
        name: String(a.secName || ''),
        date: String(a.publishTime || '').slice(0, 10),
        title,
        types: hs.map((h) => h.type),
        source: 'szse',
      })
    }
    console.log(`  源 C ${from}~${to}：公告 ${r.total} 条（实扫 ${r.list.length}），命中风险 ${hits} 条`)
  }

  // ---- 交叉比对：以 (代码, 事件类型, 月份) 为单位
  const key = (e) => `${e.code}|${e.type || e.types?.[0]}|${String(e.date).slice(0, 7)}`
  const setA = new Set(events.map(key))
  const setB = new Set(scanB.map(key))
  const setC = new Set(scanC.map(key))

  const inAonly = [...setA].filter((k) => !setB.has(k) && !setC.has(k))
  const inBnotA = [...setB].filter((k) => !setA.has(k))
  const inCnotA = [...setC].filter((k) => !setA.has(k))
  const multiSource = [...setA].filter((k) => setB.has(k) || setC.has(k))

  const bySource = {
    A_keyword: setA.size,
    B_cninfo_range: setB.size,
    C_szse: setC.size,
    A_confirmed_by_second_source: multiSource.length,
    B_found_by_scan_missed_by_keyword: inBnotA.length,
    C_found_by_exchange_missed_by_keyword: inCnotA.length,
    A_only_single_source: inAonly.length,
  }

  // ---- 复核队列：单源确认 或 源 B/C 才发现（可能被关键词漏掉）
  const review = []
  const seenKey = new Set()
  for (const k of inAonly) {
    if (review.length >= 400) break
    const e = events.find((x) => key(x) === k)
    if (!e || seenKey.has(k)) continue
    seenKey.add(k)
    review.push({ reason: 'single-source', confidence: 'B', ...e })
  }
  for (const k of inBnotA) {
    if (review.length >= 600) break
    const e = scanB.find((x) => key(x) === k)
    if (!e || seenKey.has(k)) continue
    seenKey.add(k)
    review.push({ reason: 'missed-by-keyword-scan-found', confidence: 'C', ...e })
  }
  for (const k of inCnotA) {
    if (review.length >= 700) break
    const e = scanC.find((x) => key(x) === k)
    if (!e || seenKey.has(k)) continue
    seenKey.add(k)
    review.push({ reason: 'missed-by-keyword-exchange-found', confidence: 'C', ...e })
  }

  const confA = multiSource.length
  const confB = inAonly.length
  const report = {
    generatedAt: new Date().toISOString(),
    events: events.length,
    windows,
    windowStats,
    sources: {
      A: '巨潮关键词检索（labels.js 词表）',
      B: '巨潮按日期全量扫描（无关键词，标题本地分类）',
      C: '深交所官方公告接口（深市第二披露渠道）',
    },
    bySource,
    confidence: {
      A_confirmed_2plus: confA,
      B_single_authoritative: confB,
      C_needs_review: review.filter((r) => r.confidence === 'C').length,
      A_share: events.length ? confA / events.length : null,
    },
    samples: {
      missedByKeyword: scanB.filter((e) => !setA.has(key(e))).slice(0, 10),
      exchangeConfirmed: scanC.slice(0, 10),
    },
  }

  fs.writeFileSync(path.join(DATA, 'label-validation.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(DATA, 'review-queue.jsonl'), review.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log('\n=== 三源交叉验证结果 ===')
  console.log(`  源 A（关键词）标签 ${bySource.A_keyword} 条`)
  console.log(`  源 B（按日期全量扫描）命中 ${bySource.B_cninfo_range} 条；其中关键词漏掉 ${bySource.B_found_by_scan_missed_by_keyword} 条`)
  console.log(`  源 C（深交所官方）命中 ${bySource.C_szse} 条；其中关键词漏掉 ${bySource.C_found_by_exchange_missed_by_keyword} 条`)
  console.log(`  ≥2 源确认（置信度 A）：${confA} 条（占 ${(report.confidence.A_share * 100).toFixed(1)}%）`)
  console.log(`  仅单源（置信度 B）：${confB} 条；需复核（C）：${report.confidence.C_needs_review} 条`)
  console.log(`\n  关键词漏检示例：`)
  for (const s of report.samples.missedByKeyword.slice(0, 5)) {
    console.log(`    ${s.date} ${s.code} ${s.name} ${s.title.slice(0, 46)} [${s.types.join(',')}]`)
  }
  console.log(`\n报告：${path.relative(REPO, path.join(DATA, 'label-validation.json'))}`)
  console.log(`复核队列：${path.relative(REPO, path.join(DATA, 'review-queue.jsonl'))}（${review.length} 条）`)
})()

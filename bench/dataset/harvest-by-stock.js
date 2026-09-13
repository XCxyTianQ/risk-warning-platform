#!/usr/bin/env node
/**
 * bench/dataset/harvest-by-stock.js —— 按公司定向采集公告（提升标签召回的根治做法）
 *
 * 为什么不再用关键词检索：交叉验证证明关键词有系统性漏检（标题写法千变万化）。
 * 正确做法是**按公司拉全部公告**，再用收紧后的词表在本地分类：
 *   1) 先用「按日期全量扫描」建立 代码 → orgId 映射（巨潮按股票查询必须带 orgId）
 *   2) 对队列里的每只股票，拉它 2015 年以来的全部公告（分页到底）
 *   3) 本地分类 → 与现有 events.jsonl 增量合并（按 announcementId+type 去重）
 *
 * 产出：out/orgmap.json、out/events-by-stock.jsonl、增量合并后的 out/events.jsonl
 *
 * 用法：
 *   node bench/dataset/harvest-by-stock.js --build-orgmap
 *   node bench/dataset/harvest-by-stock.js --limit 50          # 先试跑 50 只
 *   node bench/dataset/harvest-by-stock.js                     # 全队列
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
const hasFlag = (f) => argv.includes(f)
const REPO = path.resolve(__dirname, '..', '..')
const DATA = path.resolve(REPO, argOf('--data', 'bench/dataset/out'))
const SINCE = argOf('--since', '2015-01-01')
const UNTIL = argOf('--until', new Date().toISOString().slice(0, 10))
const LIMIT = Number(argOf('--limit', '0'))
const SLEEP = Number(argOf('--sleep', '180'))
const MAX_PAGES = Number(argOf('--max-pages', '40'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench by-stock harvest)' }
const stats = { requests: 0, errors: 0 }

async function post(url, bodyObj, form = false) {
  stats.requests++
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: form ? { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' } : { ...UA, 'Content-Type': 'application/json' },
      body: form ? new URLSearchParams(bodyObj).toString() : JSON.stringify(bodyObj),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    stats.errors++
    return null
  }
}

const cninfoPage = (params) =>
  post(
    'http://www.cninfo.com.cn/new/hisAnnouncement/query',
    {
      pageNum: String(params.pageNum || 1),
      pageSize: '30',
      column: 'szse',
      tabName: 'fulltext',
      plate: '',
      stock: params.stock || '',
      searchkey: params.searchkey || '',
      secid: '',
      category: '',
      trade: '',
      seDate: params.seDate || '',
      sortName: '',
      sortType: '',
      isHLtitle: 'true',
    },
    true,
  )

// ---------------------------------------------------------------- 1) 代码 → orgId
async function buildOrgMap() {
  const map = {}
  let page = 0
  // 每年扫多少页决定 orgId 覆盖率：30 页/年 ≈ 2300 只，120 页/年 ≈ 4000+ 只
  const PAGES_PER_YEAR = Number(argOf('--orgmap-pages', '120'))
  for (let y = Number(SINCE.slice(0, 4)); y <= Number(UNTIL.slice(0, 4)); y++) {
    for (let p = 1; p <= PAGES_PER_YEAR; p++) {
      const j = await cninfoPage({ pageNum: p, seDate: `${y}-01-01~${y}-12-31` })
      const list = j?.announcements || []
      if (!list.length) break
      for (const a of list) if (a.secCode && a.orgId) map[String(a.secCode)] = a.orgId
      page++
      await sleep(SLEEP)
    }
    console.log(`  orgId 映射：${Object.keys(map).length} 只（已扫到 ${y}）`)
  }
  fs.writeFileSync(path.join(DATA, 'orgmap.json'), JSON.stringify(map, null, 0))
  console.log(`  orgId 映射完成：${Object.keys(map).length} 只 → out/orgmap.json（${page} 页）`)
  return map
}

// ---------------------------------------------------------------- 2) 按公司拉全部公告
async function fetchCompany(code, orgId) {
  const out = []
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await cninfoPage({ pageNum: p, stock: `${code},${orgId}`, seDate: `${SINCE}~${UNTIL}` })
    const list = j?.announcements || []
    const total = j?.totalAnnouncement ?? 0
    if (!list.length) break
    for (const a of list) {
      const title = String(a.announcementTitle || '').replace(/<[^>]+>/g, '')
      const hits = classifyTitle(title)
      if (!hits.length) continue
      for (const h of hits) {
        out.push({
          code,
          name: String(a.secName || ''),
          type: h.type,
          severity: h.severity,
          keyword: h.keyword,
          date: a.announcementTime ? new Date(a.announcementTime).toISOString().slice(0, 10) : '',
          title,
          url: a.adjunctUrl ? `http://static.cninfo.com.cn/${a.adjunctUrl}` : '',
          announcementId: String(a.announcementId || ''),
          source: 'cninfo-by-stock',
        })
      }
    }
    if (p * 30 >= total) break
    await sleep(SLEEP)
  }
  return out
}

;(async () => {
  fs.mkdirSync(DATA, { recursive: true })
  const orgmapFile = path.join(DATA, 'orgmap.json')
  let orgmap = fs.existsSync(orgmapFile) ? JSON.parse(fs.readFileSync(orgmapFile, 'utf8')) : {}
  if (hasFlag('--build-orgmap') || Object.keys(orgmap).length < 500) {
    console.log('[1/3] 建立 代码→orgId 映射（按日期扫描）…')
    orgmap = await buildOrgMap()
  } else {
    console.log(`[1/3] 复用 代码→orgId 映射：${Object.keys(orgmap).length} 只`)
  }

  const cohort = JSON.parse(fs.readFileSync(path.join(DATA, 'cohort.json'), 'utf8'))
  let codes = [...new Set([...(cohort.cases || []), ...(cohort.controls || []), ...(cohort.extra || [])].map((x) => x.code))]
  if (LIMIT) codes = codes.slice(0, LIMIT)
  const haveOrg = codes.filter((c) => orgmap[c])
  console.log(`[2/3] 队列 ${codes.length} 只，其中 ${haveOrg.length} 只有 orgId`)

  const progressFile = path.join(DATA, 'by-stock-progress.json')
  const done = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : {}
  const byStockFile = path.join(DATA, 'events-by-stock.jsonl')
  let collected = 0
  let i = 0
  const t0 = Date.now()
  for (const code of haveOrg) {
    i++
    if (done[code] !== undefined) continue
    const rows = await fetchCompany(code, orgmap[code])
    // **逐公司落盘**：长跑中断也不丢已采数据（合并阶段按 announcementId+type 去重）
    if (rows.length) fs.appendFileSync(byStockFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    collected += rows.length
    done[code] = rows.length
    if (i % 10 === 0) {
      fs.writeFileSync(progressFile, JSON.stringify(done))
      const mins = ((Date.now() - t0) / 60000).toFixed(1)
      const rate = i / Math.max(Number(mins), 0.1)
      const left = ((haveOrg.length - i) / Math.max(rate, 0.01)).toFixed(0)
      console.log(`    进度 ${i}/${haveOrg.length}（新增命中 ${collected}，请求 ${stats.requests}，失败 ${stats.errors}，用时 ${mins}min，预计剩余 ${left}min）`)
    }
    await sleep(SLEEP)
  }
  fs.writeFileSync(progressFile, JSON.stringify(done))

  // ---------------------------------------------------------------- 3) 与现有 events.jsonl 合并
  const eventsFile = path.join(DATA, 'events.jsonl')
  const merged = new Map()
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
      if (!line) continue
      const e = JSON.parse(line)
      merged.set(`${e.announcementId}:${e.type}`, e)
    }
  }
  const before = merged.size
  // 逐公司落盘的文件是权威来源（本次进程内的 collected 只是它的子集）
  let fromFile = 0
  if (fs.existsSync(byStockFile)) {
    for (const line of fs.readFileSync(byStockFile, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        merged.set(`${e.announcementId}:${e.type}`, e)
        fromFile++
      } catch {}
    }
  }
  const all = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  fs.writeFileSync(eventsFile, all.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

  const byType = {}
  for (const e of all) byType[e.type] = (byType[e.type] || 0) + 1
  console.log(`\n[3/3] 合并：${before} → ${all.length} 条（按公司定向文件 ${fromFile} 行，本次进程新增命中 ${collected} 条）`)
  console.log(`  分类：${JSON.stringify(byType)}`)
  console.log(`  请求 ${stats.requests} 次，失败 ${stats.errors} 次`)
  fs.writeFileSync(
    path.join(DATA, 'by-stock-manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), since: SINCE, until: UNTIL, codes: haveOrg.length, added: all.length - before, total: all.length, requests: stats.requests, errors: stats.errors, byType }, null, 2),
  )
})().catch((e) => {
  console.error('失败：', e?.stack || e)
  process.exit(1)
})

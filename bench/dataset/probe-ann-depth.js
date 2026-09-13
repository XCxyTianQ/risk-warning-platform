#!/usr/bin/env node
/**
 * 探测：东财个股公告接口的历史覆盖深度（决定 replay 的非财务数据能回放到哪一年）
 * 用法：node bench/dataset/probe-ann-depth.js 002069
 */
const dns = require('node:dns')
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}

const code = process.argv[2] || '002069'
const BASE = 'https://np-anotice-stock.eastmoney.com/api/security/ann'

async function page(n, size = 100) {
  const url = `${BASE}?sr=-1&page_size=${size}&page_index=${n}&ann_type=A&client_source=web&f_node=0&s_node=0&stock_list=${code}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } })
  const j = await res.json().catch(() => null)
  const list = j?.data?.list || []
  return { total: j?.data?.total_hits ?? j?.data?.total ?? null, list }
}

;(async () => {
  let all = 0
  for (const n of [1, 5, 10, 20, 40]) {
    const { list, total } = await page(n)
    if (!list.length) {
      console.log(`page ${n}: 空（已到末页）`)
      break
    }
    const dates = list.map((x) => String(x.notice_date || '').slice(0, 10)).sort()
    all += list.length
    console.log(`page ${n}: ${list.length} 条，日期 ${dates[0]} ~ ${dates[dates.length - 1]}，total=${total}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log(`累计 ${all} 条`)
})()

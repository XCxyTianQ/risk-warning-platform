/**
 * 交易所官方公告接口探测（独立于巨潮的第二披露渠道 → 三源交叉验证的关键一环）
 */
const dns = require('node:dns')
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
}

async function tryJson(label, url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } })
    const text = await res.text()
    let count = null
    let sample = ''
    let keys = []
    try {
      const j = JSON.parse(text)
      const list = j?.data || j?.announcements || j?.results || j?.content || null
      if (Array.isArray(list)) {
        count = j.total ?? j.totalcount ?? j.recordCount ?? list.length
        keys = Object.keys(list[0] || {}).slice(0, 10)
        sample = JSON.stringify(list[0] || {}).slice(0, 220)
      } else if (list && typeof list === 'object') {
        keys = Object.keys(list).slice(0, 8)
        sample = JSON.stringify(list).slice(0, 200)
      } else {
        sample = text.replace(/\s+/g, ' ').slice(0, 140)
      }
    } catch {
      sample = text.replace(/\s+/g, ' ').slice(0, 140)
    }
    console.log(`${count ? '✅' : '❔'} ${label.padEnd(30)} status=${res.status} 条数=${count ?? '-'} ${keys.join(',')}`)
    console.log('     ', sample)
  } catch (e) {
    console.log(`❌ ${label.padEnd(30)} ${String(e.message || e).slice(0, 100)}`)
  }
}

;(async () => {
  // 深交所：公告查询（公开 JSON 接口）
  await tryJson(
    '深交所·公告查询',
    'http://www.szse.cn/api/disc/announcement/annList?random=0.1',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'http://www.szse.cn/disclosure/listed/notice/index.html' },
      body: JSON.stringify({ seDate: ['2024-01-01', '2024-12-31'], channelCode: ['listedNotice_disc'], pageSize: 30, pageNum: 1 }),
    },
  )
  await tryJson('深交所·公告（GET 版）', 'http://www.szse.cn/api/disc/announcement/annList?pageSize=5&pageNum=1')

  // 上交所：公告查询
  await tryJson(
    '上交所·公告查询',
    'http://query.sse.com.cn/security/stock/queryCompanyBulletinNew.do?jsonCallBack=jsonpCallback&isPagination=true&pageHelp.pageSize=10&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1&BEGIN_DATE=2024-01-01&END_DATE=2024-03-01',
    { headers: { Referer: 'http://www.sse.com.cn/' } },
  )

  // 上交所：监管措施/处罚
  await tryJson(
    '上交所·纪律处分',
    'http://query.sse.com.cn/commonSoaQuery.do?jsonCallBack=jsonpCallback&sqlId=BS_GGLL&isPagination=true&pageHelp.pageSize=10&pageHelp.pageNo=1',
    { headers: { Referer: 'http://www.sse.com.cn/' } },
  )

  // 巨潮：不带关键词、只按股票代码段的时间检索（看能否作为第二条检索路径）
  await tryJson('巨潮·按板块+日期（无关键词）', 'http://www.cninfo.com.cn/new/hisAnnouncement/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      pageNum: '1',
      pageSize: '30',
      column: 'szse',
      tabName: 'fulltext',
      plate: 'sz',
      stock: '',
      searchkey: '',
      secid: '',
      category: '',
      trade: '',
      seDate: '2024-01-01~2024-01-31',
      sortName: '',
      sortType: '',
      isHLtitle: 'true',
    }).toString(),
  })
})()

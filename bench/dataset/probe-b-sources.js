/**
 * B 档信源探测：为"三源交叉验证"与"债券违约/失信被执行企业"找可用接口
 * 逐个试，返回状态与样例；不假设任何接口存在。
 */
const CANDIDATES = [
  // ---- 东财 datacenter：违规/处罚类（reportName 需实测） ----
  ['东财·违规处理 RPT_ILLEGALITY', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ILLEGALITY&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·违规处理 RPT_VIOLATION', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VIOLATION&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·处罚 RPT_PUNISH', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_PUNISH&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·监管处罚 RPT_REGULATORY_PENALTY', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_REGULATORY_PENALTY&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·公司违规 RPT_COMPANY_VIOLATION', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_COMPANY_VIOLATION&columns=ALL&pageSize=3&pageNumber=1'],
  // ---- 东财 datacenter：债券/信用类 ----
  ['东财·债券违约 RPT_BOND_DEFAULT', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BOND_DEFAULT&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·信用债违约 RPT_CREDIT_BOND_DEFAULT', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_CREDIT_BOND_DEFAULT&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·债券违约统计 RPT_BOND_DEFAULT_STA', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BOND_DEFAULT_STA&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·失信被执行人 RPT_DISHONEST', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DISHONEST&columns=ALL&pageSize=3&pageNumber=1'],
  // ---- 东财 datacenter：ST / 风险警示 ----
  ['东财·风险警示 RPT_RISK_WARNING', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_RISK_WARNING&columns=ALL&pageSize=3&pageNumber=1'],
  ['东财·ST 变更 RPT_ST_CHANGE', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ST_CHANGE&columns=ALL&pageSize=3&pageNumber=1'],
  // ---- 巨潮：公告类别检索（与关键词检索是两条独立路径，可用于交叉验证） ----
  ['巨潮·类别=处罚（zjgg）', 'http://www.cninfo.com.cn/new/hisAnnouncement/query|POST|category=category_zjgg_sf&column=szse&pageSize=30&pageNum=1&tabName=fulltext'],
  ['巨潮·类别=风险警示', 'http://www.cninfo.com.cn/new/hisAnnouncement/query|POST|category=category_fxjs_szsh&column=szse&pageSize=30&pageNum=1&tabName=fulltext'],
  // ---- 最高法执行信息公开网（失信/被执行）----
  ['执行信息公开网·失信', 'https://zxgk.court.gov.cn/shixin/new_index.html'],
  ['执行信息公开网·API', 'https://zxgk.court.gov.cn/xgl/searchXglUrl?searchCourtName=&paperCode=&caseCode=&name=%E5%BA%B7%E7%BE%8E%E8%8D%AF%E4%B8%9A'],
  // ---- 国家企业信用信息公示系统（非上市企业工商）----
  ['企业信用公示·搜索', 'https://www.gsxt.gov.cn/corp-query-search-1.html'],
]

const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' }

async function probe([name, spec]) {
  const [url, method, bodyStr] = spec.split('|')
  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers: method === 'POST' ? { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' } : UA,
      body: method === 'POST' ? bodyStr : undefined,
      redirect: 'follow',
    })
    const text = await res.text()
    let count = null
    let keys = []
    let sample = ''
    try {
      const j = JSON.parse(text)
      if (Array.isArray(j?.result?.data)) {
        count = j.result.count ?? j.result.data.length
        keys = Object.keys(j.result.data[0] || {}).slice(0, 10)
        sample = JSON.stringify(j.result.data[0] || {}).slice(0, 200)
      } else if (Array.isArray(j?.announcements)) {
        count = j.totalAnnouncement ?? j.announcements.length
        keys = Object.keys(j.announcements[0] || {}).slice(0, 8)
        sample = String(j.announcements[0]?.announcementTitle || '').slice(0, 80)
      } else if (j?.success === false) {
        sample = `success=false ${JSON.stringify(j).slice(0, 120)}`
      }
    } catch {
      sample = text.replace(/\s+/g, ' ').slice(0, 120)
    }
    const ok = count !== null && count > 0
    return { name, ok, status: res.status, count, keys, sample }
  } catch (err) {
    return { name, ok: false, status: 0, error: String(err.message || err).slice(0, 90) }
  }
}

;(async () => {
  for (const c of CANDIDATES) {
    const r = await probe(c)
    console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(34)} status=${String(r.status).padStart(3)} 条数=${String(r.count ?? '-').padStart(7)} ${r.ok ? r.keys.join(',') : r.error || r.sample || ''}`)
    if (r.ok) console.log('     样例:', r.sample)
  }
})()

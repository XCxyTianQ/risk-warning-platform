#!/usr/bin/env node
/**
 * bench/dataset/harvest-nonfinancial.js —— 采集非财务维度数据（供 replay 公平评分）
 *
 * 为什么：replay 目前只喂了财报，平台六维里的 legal / news / credit 是空的
 * → 平台等于绑着一只手跟"三行财务规则"比。这一步把非财务数据补上。
 *
 * 数据源：东方财富个股公告接口（`np-anotice-stock…/security/ann`）
 *   —— 平台自己的 news 维度就用这个源（`eastmoney::fetch_news`），所以口径一致：
 *      标题加 `[公告]` 前缀、情感用平台同一套关键词规则。
 * 产出：out/news.jsonl（舆情流）、out/legal.jsonl（司法/合规记录）
 *
 * 注意：平台的 news 维度是"近 365 天"相对窗口，replay 时需要对日期做**时间平移**
 * （见 replay.js 的 shiftDays），legal 维度不看时间窗，按"≤cutoff"过滤即可。
 *
 * 用法：
 *   node bench/dataset/harvest-nonfinancial.js --limit 20     # 试跑
 *   node bench/dataset/harvest-nonfinancial.js                # 全队列（可断点续跑）
 */
const dns = require('node:dns')
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const argOf = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const REPO = path.resolve(__dirname, '..', '..')
const DATA = path.resolve(REPO, argOf('--data', 'bench/dataset/out'))
const LIMIT = Number(argOf('--limit', '0'))
const MAX_PAGES = Number(argOf('--max-pages', '15')) // 15 × 100 = 1500 条/公司，多数覆盖 2015 起
const SLEEP = Number(argOf('--sleep', '140'))
const SINCE = argOf('--since', '2015-01-01')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench nonfinancial harvest)', Referer: 'https://quote.eastmoney.com/' }

// 与平台 backend/src/datasources/mod.rs::classify_sentiment 完全一致的词表
const NEGATIVE = ['处罚','罚款','立案','调查','问询','警示','违规','违法','诉讼','起诉','被执行','失信','冻结','退市','亏损','下滑','减持','质押','风险提示','欠款','违约','停牌','暴跌','质疑','争议','限制','解禁','商誉减值']
const POSITIVE = ['增长','盈利','中标','获奖','增持','回购','分红','突破','合作','签约','创新高','上调','利好','获得','通过','入选','领先','投产','扩产']
function classifySentiment(text) {
  const neg = NEGATIVE.filter((w) => text.includes(w)).length
  const pos = POSITIVE.filter((w) => text.includes(w)).length
  return neg > pos ? 'negative' : pos > neg ? 'positive' : 'neutral'
}

// 司法/合规类关键词（进 legal_record，供 legal / credit 维度使用）
const LEGAL_KEYWORDS = ['诉讼','仲裁','被执行','失信','冻结','查封','限制消费','行政处罚','立案调查','判决','裁定','起诉']
// 例行披露的固定表述不算司法事件（与标签词表同样的教训）
const LEGAL_EXCLUDE = ['专项说明','专项审计','专项审核','汇总表','非经营性资金占用及其他关联资金往来','独立董事','保荐机构','核查意见','问询函']

const stats = { requests: 0, errors: 0 }

async function fetchAnnPage(code, pageIndex, pageSize = 100) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${pageSize}&page_index=${pageIndex}&ann_type=A&client_source=web&f_node=0&s_node=0&stock_list=${code}`
  for (let attempt = 0; attempt <= 2; attempt++) {
    stats.requests++
    try {
      const res = await fetch(url, { headers: UA })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      return j?.data?.list || []
    } catch (e) {
      if (attempt === 2) {
        stats.errors++
        return []
      }
      await sleep(500 * (attempt + 1))
    }
  }
  return []
}

;(async () => {
  fs.mkdirSync(DATA, { recursive: true })
  const cohort = JSON.parse(fs.readFileSync(path.join(DATA, 'cohort.json'), 'utf8'))
  let codes = [...new Set([...(cohort.cases || []), ...(cohort.controls || []), ...(cohort.extra || [])].map((x) => x.code))]
  if (LIMIT) codes = codes.slice(0, LIMIT)

  const progressFile = path.join(DATA, 'nonfinancial-progress.json')
  const done = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : {}
  const newsFile = path.join(DATA, 'news.jsonl')
  const legalFile = path.join(DATA, 'legal.jsonl')

  let i = 0
  let addedNews = 0
  let addedLegal = 0
  const t0 = Date.now()
  for (const code of codes) {
    i++
    if (done[code] !== undefined) continue
    const news = []
    const legal = []
    for (let p = 1; p <= MAX_PAGES; p++) {
      const list = await fetchAnnPage(code, p)
      if (!list.length) break
      let oldest = ''
      for (const it of list) {
        const title = String(it.title || '').trim()
        if (!title) continue
        const date = String(it.notice_date || '').slice(0, 10)
        if (!date) continue
        oldest = date
        if (date < SINCE) continue
        const sentiment = classifySentiment(title)
        news.push({
          code,
          title: `[公告] ${title}`.slice(0, 300),
          content: '公告类型：其他',
          source: '东方财富公告',
          url: it.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${it.art_code}.html` : '',
          published_at: date,
          sentiment,
        })
        const kw = LEGAL_EXCLUDE.some((x) => title.includes(x)) ? null : LEGAL_KEYWORDS.find((k) => title.includes(k))
        if (kw) {
          legal.push({
            code,
            case_no: '',
            doc_type: '公告',
            title: title.slice(0, 300),
            court: '',
            cause: kw,
            amount: 0,
            status: '',
            judgment_date: date,
            source: '东方财富公告',
          })
        }
      }
      if (oldest && oldest < SINCE) break // 已翻到早于起始年份，收工
      await sleep(SLEEP)
    }
    // 逐公司落盘：长跑可中断、可续跑
    if (news.length) fs.appendFileSync(newsFile, news.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    if (legal.length) fs.appendFileSync(legalFile, legal.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    addedNews += news.length
    addedLegal += legal.length
    done[code] = { news: news.length, legal: legal.length }
    if (i % 10 === 0) {
      fs.writeFileSync(progressFile, JSON.stringify(done))
      const mins = (Date.now() - t0) / 60000
      const left = ((codes.length - i) / Math.max(i / Math.max(mins, 0.1), 0.01)).toFixed(0)
      console.log(`  进度 ${i}/${codes.length}（新闻 +${addedNews}，司法 +${addedLegal}，请求 ${stats.requests}，失败 ${stats.errors}，用时 ${mins.toFixed(1)}min，预计剩余 ${left}min）`)
    }
  }
  fs.writeFileSync(progressFile, JSON.stringify(done))

  const count = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0)
  const newsTotal = count(newsFile)
  const legalTotal = count(legalFile)
  fs.writeFileSync(
    path.join(DATA, 'nonfinancial-manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), since: SINCE, maxPagesPerCompany: MAX_PAGES, codes: codes.length, news: newsTotal, legal: legalTotal, requests: stats.requests, errors: stats.errors }, null, 2),
  )
  console.log(`\n完成：新闻 ${newsTotal} 条 / 司法 ${legalTotal} 条；请求 ${stats.requests}，失败 ${stats.errors}`)
})().catch((e) => {
  console.error('失败：', e?.stack || e)
  process.exit(1)
})

/**
 * 取 A 股「贵金属」板块成分股，按总市值排序取前十（数据源：东方财富公开行情接口）。
 * 只做数据获取与打印，不做任何推测；拿不到就报错，不用记忆补。
 */
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}
const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }

async function j(url) {
  const r = await fetch(url, { headers: UA })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`)
  return r.json()
}

;(async () => {
  // 1) 找板块代码
  const boards = await j('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14')
  const list = (boards.data && boards.data.diff) || []
  const hit = list.filter((x) => /贵金属|黄金/.test(x.f14))
  console.log('=== 匹配到的板块 ===')
  for (const b of hit) console.log(`  ${b.f12}  ${b.f14}`)
  const board = hit.find((x) => x.f14 === '贵金属') || hit[0]
  if (!board) throw new Error('未找到贵金属板块')
  console.log(`选用板块：${board.f12} ${board.f14}`)

  // 2) 取成分股，按总市值降序
  const fields = 'f12,f14,f2,f3,f9,f20,f21,f23,f100'
  const cons = await j(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:${board.f12}&fields=${fields}`)
  const rows = (cons.data && cons.data.diff) || []
  console.log(`\n=== ${board.f14} 板块成分股 ${rows.length} 只，按总市值前十 ===`)
  console.log('排名  代码     名称        总市值(亿)  流通市值(亿)  最新价   涨跌%   PE(动)   PB')
  rows.slice(0, 10).forEach((x, i) => {
    const yi = (v) => (typeof v === 'number' ? (v / 1e8).toFixed(1) : '—')
    console.log(
      `${String(i + 1).padStart(3)}   ${String(x.f12).padEnd(7)} ${String(x.f14).padEnd(11)} ` +
      `${yi(x.f20).padStart(10)} ${yi(x.f21).padStart(12)} ${String(x.f2).padStart(8)} ${String(x.f3).padStart(6)} ${String(x.f9).padStart(7)} ${String(x.f23).padStart(5)}`
    )
  })
  console.log(`\n数据时间：${new Date().toISOString()}（东方财富实时接口）`)
  require('node:fs').writeFileSync(require('node:path').join(__dirname, 'out', 'precious-metals-top10.json'),
    JSON.stringify({ fetchedAt: new Date().toISOString(), board, all: rows, top10: rows.slice(0, 10) }, null, 2))
  console.log('产物 → bench/external/out/precious-metals-top10.json')
})().catch((e) => { console.error('失败：', e.message); process.exit(1) })

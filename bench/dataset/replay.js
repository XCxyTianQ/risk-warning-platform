#!/usr/bin/env node
/**
 * bench/dataset/replay.js —— 平台评分 replay（A 档第 4 项）
 *
 * 要回答的问题：**平台的评分，比"高负债+亏损"这种传统财务规则强多少？**
 * 办法：对每个 cutoff（如 2017-04-30），把"当时已经披露"的财报写进一个**临时库**，
 * 起一个平台后端，问它要评分与金融分析结论 —— 平台自己算，而不是我们替它算。
 *
 * 严格性：
 *   · 只写 `noticeDate ≤ cutoff` 的财报（披露日期口径，不是报告期）；
 *   · 每个 cutoff 一个**独立临时库 + 独立后端**，互不污染；
 *   · 只喂财报（news/legal 历史数据尚未采集）→ 平台的非财务维度会缺失，
 *     所以这是**对平台保守（不利）的对比**，结论只会更稳。
 *
 * 产出：bench/dataset/out/replay-scores.jsonl
 *   每行 = { code, cutoff, riskScore, riskLevel, grade, zScore, anomalies, financeAvailable }
 *
 * 用法：
 *   node bench/dataset/replay.js --data bench/dataset/out [--cutoffs 2017-04-30,...]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..')
const argv = process.argv.slice(2)
const argOf = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DATA = path.resolve(REPO, argOf('--data', 'bench/dataset/out'))
const CUTOFFS = argOf('--cutoffs', '2016-04-30,2017-04-30,2018-04-30,2019-04-30,2020-04-30,2021-04-30,2022-04-30,2023-04-30,2024-04-30')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const KEEP_DIR = argv.includes('--keep-dir')

const { startBackend, resolveBackendBin } = require('../lib/backends')
const { freePort, sleep } = require('../lib/util')

const readJsonl = (f) => {
  const p = path.join(DATA, f)
  return fs.existsSync(p)
    ? fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 把一条面板记录转成平台 finance 表的行（万元口径） */
function toFinanceRow(code, enterpriseId, r) {
  const wan = (v) => (num(v) === null ? null : Math.round((v / 10000) * 100) / 100)
  const assets = wan(r.total_assets)
  const liab = wan(r.total_liabilities)
  const debtRatio = assets && liab !== null && assets !== 0 ? Math.round((liab / assets) * 10000) / 100 : null
  const year = Number(String(r.reportDate).slice(0, 4))
  // 平台 finance 表对 (enterprise_id, year, report_type) 有唯一约束 → 四个报告期必须区分开
  const md = String(r.reportDate).slice(5)
  const reportType = md === '12-31' ? '年报' : md === '06-30' ? '中报' : md === '03-31' ? '一季报' : md === '09-30' ? '三季报' : '其他'
  return {
    year,
    report_type: reportType,
    total_assets: assets ?? 0,
    total_liabilities: liab ?? 0,
    // 平台表里这些列是 NOT NULL：面板缺项统一写 0，避免整库构建失败
    revenue: wan(r.revenue) ?? 0,
    net_profit: wan(r.net_profit) ?? 0,
    debt_ratio: debtRatio ?? 0,
    metrics_json: JSON.stringify({
      equity: wan(r.equity),
      current_assets: wan(r.current_assets),
      current_liabilities: wan(r.current_liabilities),
      inventory: wan(r.inventory),
      accounts_receivable: wan(r.accounts_receivable),
      operating_cost: wan(r.operating_cost),
      monetary_funds: wan(r.monetary_funds),
      notice_date: r.noticeDate || r.reportDate,
    }),
  }
}

/** 用 Python 直接建库（平台 schema 由后端启动时自动建；这里只灌数据，简单可控） */
function buildDb(dbFile, enterprises, financeRows, newsRows = [], legalRows = []) {
  const payload = JSON.stringify({ enterprises, finance: financeRows, news: newsRows, legal: legalRows })
  const tmp = dbFile + '.payload.json'
  fs.writeFileSync(tmp, payload, 'utf8')
  const py = `
import json, sqlite3, sys
db, payload_file = sys.argv[1], sys.argv[2]
data = json.load(open(payload_file, encoding="utf-8"))
con = sqlite3.connect(db)
cur = con.cursor()
idmap = {}
# 维度是否参与评分取决于 enterprise.data_status_json[dim]（rules.rs::status_of）：
# 只写 finance 会让 news/legal/credit/operation/supply 全部被跳过 → 必须按实际数据标注
dims = {}
for f in data["finance"]:
    dims.setdefault(f["code"], set()).add("finance")
for n in data.get("news", []):
    dims.setdefault(n["code"], set()).add("news")
for l in data.get("legal", []):
    dims.setdefault(l["code"], set()).add("legal")
for e in data["enterprises"]:
    d = dims.get(e["code"], set())
    status = {}
    if "finance" in d:
        status["finance"] = "ok"
        status["operation"] = "ok"
    if "legal" in d:
        status["legal"] = "ok"
        status["credit"] = "ok"
    if "news" in d:
        status["news"] = "ok"
        status["supply"] = "ok"
    cur.execute(
        "INSERT OR IGNORE INTO enterprise (name, unified_code, stock_code, industry, reg_date, data_note, data_status_json) VALUES (?,?,?,?,?,?,?)",
        (e["name"], "", e["code"], e.get("industry") or "", e.get("regDate") or "2010-01-01", "replay", json.dumps(status, ensure_ascii=False)),
    )
    idmap[e["code"]] = cur.lastrowid
for f in data["finance"]:
    eid = idmap.get(f["code"])
    if not eid: continue
    cur.execute("INSERT INTO finance (enterprise_id, year, report_type, total_assets, total_liabilities, revenue, net_profit, debt_ratio, source, metrics_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (eid, f["year"], f["report_type"], f["total_assets"], f["total_liabilities"], f["revenue"], f["net_profit"], f["debt_ratio"], "replay", f["metrics_json"]))
for n in data.get("news", []):
    eid = idmap.get(n["code"])
    if not eid: continue
    cur.execute("INSERT INTO news (enterprise_id, title, content, source, url, published_at, sentiment) VALUES (?,?,?,?,?,?,?)",
                (eid, n["title"], n.get("content") or "", n.get("source") or "replay", n.get("url") or "", n["published_at"], n.get("sentiment") or "neutral"))
for l in data.get("legal", []):
    eid = idmap.get(l["code"])
    if not eid: continue
    cur.execute("INSERT INTO legal_record (enterprise_id, case_no, doc_type, title, court, cause, amount, status, judgment_date, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (eid, l.get("case_no") or "", l.get("doc_type") or "公告", l["title"], l.get("court") or "", l.get("cause") or "", float(l.get("amount") or 0), l.get("status") or "", l["judgment_date"], l.get("source") or "replay"))
con.commit()
print(json.dumps({"enterprises": len(idmap), "finance": len(data["finance"]), "news": len(data.get("news", [])), "legal": len(data.get("legal", [])), "idmap": idmap}))
`
  const ps = path.join(os.tmpdir(), `replay-build-${Date.now()}.py`)
  fs.writeFileSync(ps, py, 'utf8')
  const r = spawnSync('python', [ps, dbFile, tmp], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
  fs.rmSync(tmp, { force: true })
  fs.rmSync(ps, { force: true })
  if (r.status !== 0) throw new Error(`建库失败：${String(r.stderr).slice(-1200)}`)
  return JSON.parse(r.stdout)
}

async function post(port, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null }
  }
}

async function get(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`)
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null }
  }
}

;(async () => {
  const panel = readJsonl('panel.jsonl')
  const news = readJsonl('news.jsonl')
  const legal = readJsonl('legal.jsonl')
  const cohort = JSON.parse(fs.readFileSync(path.join(DATA, 'cohort.json'), 'utf8'))
  const universe = readJsonl('universe.jsonl')
  if (!panel.length) {
    console.error('缺少面板数据：先跑 fetch.js')
    process.exit(2)
  }
  const newsByCode = new Map()
  for (const n of news) {
    if (!newsByCode.has(n.code)) newsByCode.set(n.code, [])
    newsByCode.get(n.code).push(n)
  }
  const legalByCode = new Map()
  for (const l of legal) {
    if (!legalByCode.has(l.code)) legalByCode.set(l.code, [])
    legalByCode.get(l.code).push(l)
  }
  console.log(`非财务数据：新闻 ${news.length} 条（${newsByCode.size} 只）/ 司法 ${legal.length} 条（${legalByCode.size} 只）`)
  const byCode = new Map()
  for (const r of panel) {
    if (!byCode.has(r.code)) byCode.set(r.code, [])
    byCode.get(r.code).push(r)
  }
  const meta = new Map(universe.map((u) => [u.code, u]))
  const bin = resolveBackendBin(REPO)
  if (!bin) {
    console.error('找不到后端二进制')
    process.exit(2)
  }

  const out = []
  const summary = []
  for (const cutoff of CUTOFFS) {
    // 只取"当时已披露"的财报
    const rows = []
    for (const [code, list] of byCode) {
      for (const r of list) {
        const d = r.noticeDate || r.reportDate
        if (!d || d > cutoff) continue
        if (num(r.total_assets) === null) continue // 没有资产总计的记录对评分无意义
        rows.push({ code, ...r })
      }
    }
    const codes = [...new Set(rows.map((r) => r.code))]
    if (!codes.length) {
      console.log(`  ${cutoff}：无可用财报，跳过`)
      continue
    }
    // 去重：(企业, 年, 报告期) 只能有一条 → 取"截止该 cutoff 最近一次披露"的那条
    const dedup = new Map()
    for (const r of rows) {
      const f = toFinanceRow(r.code, 0, r)
      const key = `${r.code}|${f.year}|${f.report_type}`
      const prev = dedup.get(key)
      const d = r.noticeDate || r.reportDate
      if (!prev || d > prev.d) dedup.set(key, { d, code: r.code, ...f })
    }
    const financeRows = [...dedup.values()].map(({ d, ...f }) => f)
    const enterprises = codes.map((c) => ({ code: c, name: meta.get(c)?.name || c, industry: meta.get(c)?.industry || '', regDate: meta.get(c)?.listDate || '' }))

    // 非财务数据（point-in-time）
    //  · legal：规则引擎不看时间窗 → 只放"判决/公告日 ≤ cutoff"的记录
    //  · news ：规则引擎看"近 365 天"（相对**当前**）→ 必须做**时间平移**：
    //           把 cutoff 当作"今天"，因此 published_at 统一后移 shiftDays 天
    const shiftDays = Math.round((Date.now() - new Date(cutoff).getTime()) / 86400000)
    const shiftDate = (d) => new Date(new Date(d).getTime() + shiftDays * 86400000).toISOString().slice(0, 10)
    const newsRows = []
    for (const code of codes) {
      for (const n of newsByCode.get(code) || []) {
        if (!n.published_at || n.published_at > cutoff) continue
        newsRows.push({ code, title: n.title, content: n.content, source: n.source, url: n.url, published_at: shiftDate(n.published_at), sentiment: n.sentiment })
      }
    }
    const legalRows = []
    for (const code of codes) {
      for (const l of legalByCode.get(code) || []) {
        if (!l.judgment_date || l.judgment_date > cutoff) continue
        legalRows.push({ code, ...l })
      }
    }

    const dir = path.join(os.tmpdir(), `rwp-replay-${cutoff.replace(/-/g, '')}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const dbFile = path.join(dir, 'platform.db')
    // 先起一次后端让它建 schema，再灌数据（避免手写 schema 漂移）
    const port0 = await freePort()
    const boot = await startBackend({ bin: bin.bin, port: port0, dataDir: dir, webDist: path.join(REPO, 'desktop/resources/web'), logFile: path.join(dir, 'boot.log') })
    await boot.stop()

    const built = buildDb(dbFile, enterprises, financeRows, newsRows, legalRows)

    const port = await freePort()
    const handle = await startBackend({
      bin: bin.bin,
      port,
      dataDir: dir,
      webDist: path.join(REPO, 'desktop/resources/web'),
      logFile: path.join(dir, 'backend.log'),
    })
    if (handle.readyMs === null) {
      console.error(`  ${cutoff}：后端未就绪，跳过`)
      await handle.stop()
      continue
    }

    const ents = await get(port, '/api/enterprises')
    const items = ents.json?.items || []
    const idmap = built.idmap || {}
    const byId = new Map(Object.entries(idmap).map(([code, id]) => [Number(id), code]))
    let scored = 0
    for (const it of items) {
      // 代码以自己建库时的映射为准（接口列表未必回传 stock_code）
      const code = byId.get(Number(it.id)) || it.stock_code || ''
      const risk = await get(port, `/api/enterprise/${it.id}/risk`)
      const fin = await get(port, `/api/finance/${it.id}/analysis`)
      const rj = risk.json || {}
      const fj = fin.json || {}
      const anomalies = Array.isArray(fj.anomalies) ? fj.anomalies.length : null
      const highAnoms = Array.isArray(fj.anomalies) ? fj.anomalies.filter((a) => a.level === 'high' || a.level === 'red').length : null
      // 平台自带的三个模型（字段路径以 /api/finance/{id}/analysis 实测为准）
      const altmanZ = num(fj.models?.altman?.z?.score)
      const beneish = num(fj.models?.beneish?.score)
      const piotroski = num(fj.models?.piotroski?.score)
      out.push({
        code,
        enterpriseId: it.id,
        cutoff,
        // 平台六维综合分：越高越健康 → 取 100-score 作为"风险信号"（越大越危险）
        riskScore: num(rj.score),
        riskSignal: num(rj.score) === null ? null : Math.round((100 - num(rj.score)) * 100) / 100,
        riskGrade: rj.grade ?? null,
        riskLevel: rj.verdict_level ?? rj.level ?? null,
        financeDimensionScore: num(rj.dimensions?.finance?.score),
        financeSignal: num(rj.dimensions?.finance?.score) === null ? null : Math.round((100 - num(rj.dimensions.finance.score)) * 100) / 100,
        creditDimensionScore: num(rj.dimensions?.credit?.score),
        dimensionScores: rj.dimensions ? Object.fromEntries(Object.entries(rj.dimensions).map(([k, v]) => [k, num(v?.score)])) : null,
        altmanZ,
        beneish,
        piotroski,
        anomalies,
        highAnoms,
        financeAvailable: fj.available === true,
        financeYears: Array.isArray(fj.data_quality?.periods) ? fj.data_quality.periods.length : null,
      })
      scored++
    }
    await handle.stop()
    if (KEEP_DIR) console.log(`    临时库保留在：${dir}`)
    else fs.rmSync(dir, { recursive: true, force: true })
    summary.push({ cutoff, enterprises: built.enterprises, financeRows: built.finance, newsRows: built.news, legalRows: built.legal, scored, withScore: out.filter((o) => o.cutoff === cutoff && o.riskScore !== null).length })
    console.log(`  ${cutoff}：企业 ${built.enterprises} / 财报 ${built.finance} / 新闻 ${built.news} / 司法 ${built.legal} / 评分 ${scored}（有综合分 ${summary[summary.length - 1].withScore}）`)
  }

  const file = path.join(DATA, 'replay-scores.jsonl')
  fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  fs.writeFileSync(path.join(DATA, 'replay-manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), cutoffs: CUTOFFS, summary, rows: out.length }, null, 2))
  console.log(`\nreplay 完成：${out.length} 行 → ${path.relative(REPO, file)}`)
})().catch((e) => {
  console.error('replay 失败：', e?.stack || e)
  process.exit(1)
})

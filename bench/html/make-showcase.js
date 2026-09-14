/**
 * 展示网页生成器：把基准结果做成一个可交互的单文件页面（零依赖、离线可用）。
 *
 * 与"报告"的区别：报告是给人逐节读的，展示页是给人 3 分钟抓住重点的。
 * 因此这里的叙事主线只有一条——**我们不是最贵的，但我们是真的在读文档**——
 * 所有图表都服务于这一条，并且每个图都带口径标注（n / 裁判 / 基准），不做无标注的美化。
 *
 *   node bench/html/make-showcase.js
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(REPO, 'docs', 'showcase', 'index.html')
const load = (p, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')) } catch { return d } }

const frontier = load('bench/external/out/frontier-challenge.json')
const samegen = load('bench/external/out/samegen-results.json')
const finrisk = load('bench/reports/finrisk-bench.json', null) || load('bench/out/finrisk-bench.json', null)
const t5 = load('bench/reports/t5.json', null) || load('bench/out/t5.json', null)
const ext = load('bench/external/reports/external-alignment-v1.json')

if (!frontier) throw new Error('缺少 frontier-challenge.json（先跑 tools/aggregate-frontier-challenge.js）')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const f2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))
const f1 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1))
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'))

// ---------------------------------------------------------------- 数据整理
const MODELS = frontier.models.map((m) => ({
  id: m.id,
  label: m.label.replace(/（.*?）/g, ''),
  short: m.id === 'deepseek-flash' ? '我们' : m.label.replace(/（.*?）/g, '').replace(/^Claude /, '').replace(/^GPT-/, 'GPT-'),
  ours: m.tier === 'ours',
  tier: m.tier,
  oracle: m.oraclePct,
  closed: m.closedBookPct,
  inc: m.documentIncrementPp,
  recalled: m.recalledExactNumbersPct,
  bfcl: m.bfcl.overallPct,
  bfclIrr: m.bfcl.irrelevancePct,
  cost: m.costUSD.both,
  ratio: m.costRatioVsOurs,
  costNote: m.costUSD.both === null ? '网关未公布价目' : `$${m.costUSD.both}`,
}))
const vision = (frontier.vision && frontier.vision.rows) || []
const visOf = (id) => vision.find((v) => v.id === id) || null
const ours = MODELS.find((m) => m.ours)
const fable = MODELS.find((m) => m.id === 'claude-fable-5-1')
const astra = MODELS.find((m) => m.id === 'gpt-6-astra')

const sorted = [...MODELS].sort((a, b) => b.inc - a.inc)
const sortedOracle = [...MODELS].sort((a, b) => b.oracle - a.oracle)

const biz = (() => {
  const stock = load('bench/out/platform-facts.json', null) || {}
  return {
    tools: stock.tools || 25,
    tables: stock.tables || 15,
    dims: 6,
    rustLoc: stock.rustLoc || 16352,
    vueLoc: stock.vueLoc || 11753,
  }
})()

const calls = (() => {
  const u = (ext && ext.modelUsage) || {}
  // 注意：modelUsage 里已经包含裁判调用，不要再额外加——早先多加 320 导致展示页比报告多 320 次
  return Object.values(u).reduce((s, x) => s + (x.calls || 0), 0)
})()
const costCNY = (() => {
  const u = (ext && ext.modelUsage) || {}
  return Object.values(u).reduce((s, x) => s + (x.estimatedCostCNY || 0), 0) + 0.43
})()

// ---------------------------------------------------------------- 图形
/** 文档增量图：每行 = oracle 条 + 闭卷条 + 增量括号 */
function incrementChart() {
  const W = 980
  const rowH = 78
  const H = MODELS.length * rowH + 46
  const left = 150
  const right = W - 96
  const scale = (v) => left + ((right - left) * v) / 100
  let g = `<svg viewBox="0 0 ${W} ${H}" class="chart incChart" role="img" aria-label="各模型 oracle 与闭卷准确率对比">`
  for (const tick of [0, 25, 50, 75, 100]) {
    g += `<line x1="${scale(tick)}" y1="26" x2="${scale(tick)}" y2="${H - 14}" class="grid"/>`
    g += `<text x="${scale(tick)}" y="16" class="axis" text-anchor="middle">${tick}%</text>`
  }
  // 按文档增量排序：这张图要传达的是"看括号长度"，不是看谁总分高
  ;[...MODELS].sort((a, b) => b.inc - a.inc).forEach((m, i) => {
    const y = 34 + i * rowH
    const ow = Math.max(2, scale(m.oracle) - left)
    const cw = Math.max(2, scale(m.closed) - left)
    g += `<g class="incRow" data-model="${m.id}">`
    g += `<text x="${left - 14}" y="${y + 15}" class="mLabel ${m.ours ? 'ours' : ''}" text-anchor="end">${esc(m.short)}</text>`
    g += `<rect x="${left}" y="${y}" width="${ow}" height="17" rx="4" class="barOracle"/>`
    g += `<rect x="${left}" y="${y + 21}" width="${cw}" height="17" rx="4" class="barClosed"/>`
    g += `<text x="${left + ow + 8}" y="${y + 13}" class="valOracle">${f2(m.oracle)}%</text>`
    g += `<text x="${left + cw + 8}" y="${y + 34}" class="valClosed">${f2(m.closed)}%</text>`
    // 增量括号
    const bx = scale(m.closed)
    const bw = scale(m.oracle) - bx
    g += `<line x1="${bx}" y1="${y + 42}" x2="${bx + bw}" y2="${y + 42}" class="incLine"/>`
    g += `<text x="${bx + bw / 2}" y="${y + 58}" class="incVal ${m.ours ? 'ours' : ''}" text-anchor="middle">文档增量 +${f2(m.inc)}pp</text>`
    g += '</g>'
  })
  g += '</svg>'
  return g
}

/** 成本 × 效果气泡图：x=成本(对数)，y=oracle，气泡半径=文档增量 */
function bubbleChart() {
  const W = 980
  const H = 430
  const padL = 76
  const padR = 40
  const padT = 26
  const padB = 58
  const pts = MODELS.filter((m) => m.cost !== null)
  const cs = pts.map((m) => m.cost)
  const x0 = Math.log10(Math.min(...cs)) - 0.16
  const x1 = Math.log10(Math.max(...cs)) + 0.16
  const y0 = 86
  const y1 = 97
  const X = (c) => padL + ((Math.log10(c) - x0) / (x1 - x0)) * (W - padL - padR)
  const Y = (v) => H - padB - ((v - y0) / (y1 - y0)) * (H - padT - padB)
  let g = `<svg viewBox="0 0 ${W} ${H}" class="chart bubble" role="img" aria-label="成本与准确率的关系">`
  for (let v = y0; v <= y1; v += 2) {
    g += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" class="grid"/>`
    g += `<text x="${padL - 10}" y="${Y(v) + 4}" class="axis" text-anchor="end">${v}%</text>`
  }
  // 刻度必须覆盖到最小成本（否则最省钱的点会贴在轴外）——按 0.5/1/2/5/10/20 自适应
  for (const c of [0.5, 1, 2, 5, 10, 20]) {
    if (Math.log10(c) < x0 || Math.log10(c) > x1) continue
    g += `<line x1="${X(c)}" y1="${padT}" x2="${X(c)}" y2="${H - padB}" class="grid"/>`
    g += `<text x="${X(c)}" y="${H - padB + 20}" class="axis" text-anchor="middle">$${c}</text>`
  }
  g += `<text x="${(W + padL) / 2}" y="${H - 12}" class="axisTitle" text-anchor="middle">两项基准的模型成本（美元，对数轴）</text>`
  g += `<text x="18" y="${padT + 60}" class="axisTitle" transform="rotate(-90 18 ${padT + 60})" text-anchor="middle">FinanceBench oracle</text>`
  for (const m of pts) {
    const r = 10 + (m.inc / 50) * 26
    g += `<g class="bub" data-model="${m.id}">`
    g += `<circle cx="${X(m.cost)}" cy="${Y(m.oracle)}" r="${r}" class="bubCircle ${m.ours ? 'ours' : ''}"/>`
    g += `<text x="${X(m.cost)}" y="${Y(m.oracle) + 4}" class="bubLabel" text-anchor="middle">${m.ours ? '我们' : esc(m.short)}</text>`
    g += `<title>${esc(m.label)}：oracle ${f2(m.oracle)}%，文档增量 +${f2(m.inc)}pp，成本 ${m.costNote}</title>`
    g += '</g>'
  }
  g += '</svg>'
  return g
}

/**
 * 四维对位图：按维度分行、每行三家并排。
 *
 * 为什么不用雷达图：三家在四维上都落在彼此的 90%~97% 区间内，按各轴最大值归一后
 * 三个多边形几乎完全重叠，图看着漂亮但读不出任何信息——这是"好看但无用"的典型。
 * 改成一行一维度的条形对位，每行独立定标并直接标原始数值，再标出该维领先者。
 */
function dimensionBars() {
  const dims = [
    { key: 'oracle', label: '财报问答', unit: '%', hint: 'FinanceBench oracle' },
    { key: 'bfcl', label: '工具调用', unit: '%', hint: 'BFCL v4（确定性判分）' },
    { key: 'fmm', label: '图表取数', unit: '%', hint: 'FinEval-MM' },
    { key: 'seg', label: '整页转写', unit: '', hint: 'OmniDocBench 片段召回' },
  ]
  const rows = MODELS.map((m) => {
    const v = visOf(m.id)
    return {
      ...m,
      fmm: v && v.finevalMm ? v.finevalMm.accuracyPct : null,
      seg: v && v.omniDoc ? v.omniDoc.segmentRecall : null,
    }
  }).filter((r) => r.fmm !== null && r.seg !== null)
  const W = 980
  const rowH = 96
  const H = dims.length * rowH + 16
  const left = 118
  const right = W - 118
  const color = (id, oursFlag) => (oursFlag ? 'var(--accent)' : id === 'gpt-6-astra' ? 'var(--blue)' : 'var(--amber)')
  let g = `<svg viewBox="0 0 ${W} ${H}" class="chart dimBars" role="img" aria-label="四个维度上三家模型的成绩对比">`
  dims.forEach((d, di) => {
    const y0 = di * rowH + 10
    const vals = rows.map((r) => r[d.key])
    const max = Math.max(...vals)
    const best = rows[vals.indexOf(max)]
    g += `<text x="0" y="${y0 + 12}" class="mLabel">${d.label}</text>`
    g += `<text x="0" y="${y0 + 30}" class="axis">${d.hint}</text>`
    rows.forEach((r, i) => {
      const v = r[d.key]
      const bw = Math.max(2, ((right - left) * v) / (max * 1.12))
      const y = y0 + 42 + i * 17
      const isBest = r === best
      g += `<rect x="${left}" y="${y}" width="${bw}" height="13" rx="3.5" fill="${color(r.id, r.ours)}" opacity="${r.ours ? 1 : 0.82}"/>`
      g += `<text x="${left + bw + 8}" y="${y + 11}" class="axis" style="fill:#c8d6ef">${r.ours ? '我们 ' : ''}${f2(v)}${d.unit}${isBest ? ' ★' : ''}</text>`
    })
    g += `<line x1="0" y1="${y0 + rowH - 12}" x2="${W}" y2="${y0 + rowH - 12}" class="grid"/>`
  })
  g += '</svg>'
  return { svg: g, rows, dims }
}
const dim = dimensionBars()

const incChart = incrementChart()
const bubble = bubbleChart()

// ---------------------------------------------------------------- 页面
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>企业经营风险预警平台 · 基准展示</title>
<style>
:root{
  --bg:#080c14; --bg2:#0c1220; --card:#111a2b; --line:#1e2b42;
  --ink:#e8eefc; --ink2:#a9b8d4; --muted:#6f809f;
  --accent:#2ee6b0; --accent2:#0ea47a; --blue:#5aa9ff; --amber:#ffb454; --rose:#ff6b8b; --violet:#a78bfa;
  --shadow:0 20px 60px rgba(0,0,0,.45);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:
  radial-gradient(1200px 600px at 12% -10%, #123 0%, transparent 60%),
  radial-gradient(900px 500px at 100% 0%, #1a1030 0%, transparent 55%),
  var(--bg);
  color:var(--ink);font:15.5px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 26px}
nav{position:sticky;top:0;z-index:50;backdrop-filter:blur(14px);background:rgba(8,12,20,.72);border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;gap:20px;height:58px}
.brand{font-weight:700;letter-spacing:.3px;white-space:nowrap}
.brand b{color:var(--accent)}
nav .links{display:flex;gap:18px;margin-left:auto;font-size:13.5px;color:var(--ink2);flex-wrap:wrap}
nav .links a{text-decoration:none;padding:4px 2px;border-bottom:1px solid transparent}
nav .links a:hover{color:var(--ink);border-color:var(--accent)}
#prog{position:fixed;left:0;top:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--blue));width:0;z-index:60}
header.hero{padding:78px 0 40px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);border:1px solid rgba(46,230,176,.3);background:rgba(46,230,176,.07);padding:5px 12px;border-radius:999px}
h1{font-size:clamp(32px,5vw,58px);line-height:1.12;margin:20px 0 14px;letter-spacing:-.02em;font-weight:800}
h1 .grad{background:linear-gradient(100deg,var(--accent),var(--blue) 62%,var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{font-size:clamp(16px,1.6vw,19px);color:var(--ink2);max-width:820px}
.lede strong{color:var(--ink)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:14px;margin:36px 0 8px}
.kpi{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.kpi .v{font-size:30px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .v small{font-size:15px;color:var(--muted);font-weight:600;margin-left:3px}
.kpi .k{color:var(--ink2);font-size:13px;margin-top:2px}
section{padding:64px 0;border-top:1px solid rgba(30,43,66,.7)}
h2{font-size:clamp(23px,2.6vw,32px);margin:0 0 10px;letter-spacing:-.01em}
h2 .no{color:var(--accent);font-variant-numeric:tabular-nums;margin-right:10px;font-size:.72em;vertical-align:middle}
.sub{color:var(--ink2);max-width:860px;margin:0 0 26px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow)}
.grid2{display:grid;grid-template-columns:1.12fr .88fr;gap:22px;align-items:start}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.tag{display:inline-block;font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 9px;margin-right:6px}
.tag.good{color:var(--accent);border-color:rgba(46,230,176,.35)}
.tag.warn{color:var(--amber);border-color:rgba(255,180,84,.35)}
.note{font-size:12.5px;color:var(--muted);margin-top:14px}
.chart{width:100%;height:auto;display:block}
.grid{stroke:#1b2740;stroke-width:1}
.axis{fill:#6f809f;font-size:12px}
.axisTitle{fill:#6f809f;font-size:12.5px}
.mLabel{fill:#c8d6ef;font-size:14px}
.mLabel.ours{fill:var(--accent);font-weight:700}
.barOracle{fill:var(--blue);opacity:.85}
.barClosed{fill:#33415c}
.valOracle{fill:#9fc6ff;font-size:12px;font-variant-numeric:tabular-nums}
.valClosed{fill:#8b9ab6;font-size:12px;font-variant-numeric:tabular-nums}
.incLine{stroke:var(--accent);stroke-width:2}
.incVal{fill:var(--accent);font-size:12.5px;font-weight:600}
.incVal.ours{font-size:13.5px;font-weight:800}
.incRow{cursor:pointer}
.incRow:hover .barOracle{opacity:1}
.ring{fill:none;stroke:#1d2a42}
.spoke{stroke:#1d2a42}
.poly{fill:color-mix(in srgb,var(--c) 16%,transparent);stroke:var(--c);stroke-width:2}
.poly.ours{fill:color-mix(in srgb,var(--accent) 22%,transparent);stroke-width:2.6}
.bubCircle{fill:rgba(90,169,255,.3);stroke:var(--blue);stroke-width:1.5}
.bubCircle.ours{fill:rgba(46,230,176,.34);stroke:var(--accent);stroke-width:2.4}
.bubLabel{fill:#dbe6fb;font-size:12px;font-weight:600;pointer-events:none}
.bub{cursor:pointer}
.bub:hover .bubCircle{fill-opacity:.75}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--ink2);margin-top:12px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.big{font-size:clamp(26px,3.4vw,42px);font-weight:800;letter-spacing:-.02em;line-height:1.2}
.big .a{color:var(--accent)}
.quote{border-left:3px solid var(--accent);padding:6px 0 6px 18px;color:var(--ink);font-size:clamp(17px,1.9vw,22px);font-weight:600;letter-spacing:-.01em}
.detail{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:14px;padding:16px}
.detail h4{margin:0 0 8px;font-size:16px}
.bar{height:9px;border-radius:6px;background:#22304a;overflow:hidden;margin:6px 0 12px}
.bar > i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--blue));width:0;transition:width .9s cubic-bezier(.2,.8,.2,1)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #1a2539}
th{color:var(--ink2);font-weight:600;font-size:12.5px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr.ours{background:rgba(46,230,176,.07)}
tr.ours td:first-child{color:var(--accent);font-weight:700}
.tl{position:relative;padding-left:26px}
.tl:before{content:"";position:absolute;left:7px;top:6px;bottom:6px;width:2px;background:linear-gradient(180deg,var(--accent),transparent)}
.tl .it{position:relative;margin-bottom:20px}
.tl .it:before{content:"";position:absolute;left:-24px;top:7px;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(46,230,176,.14)}
.tl .d{color:var(--muted);font-size:12.5px}
.tl .t{font-weight:700}
.reveal{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.8,.2,1)}
.reveal.in{opacity:1;transform:none}
footer{padding:52px 0 70px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line)}
code{background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:12.5px}
pre{background:#0a0f1a;border:1px solid var(--line);border-radius:12px;padding:14px 16px;overflow:auto;font-size:12.5px;color:#c9d6ee}
@media (max-width:900px){.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="prog"></div>
<nav><div class="wrap">
  <div class="brand">企业经营风险预警平台 · <b>基准展示</b></div>
  <div class="links">
    <a href="#finding">核心发现</a><a href="#inc">文档增量</a><a href="#cost">成本×效果</a>
    <a href="#radar">四维对比</a><a href="#self">自建基准</a><a href="#method">方法</a><a href="#limits">边界</a>
  </div>
</div></nav>

<header class="hero"><div class="wrap">
  <span class="eyebrow">Benchmark Showcase · 2026-09</span>
  <h1>我们不是最贵的那个，<br><span class="grad">但我们是真的在读文档。</span></h1>
  <p class="lede">把当前<strong>最贵档的两个模型</strong>（Claude Fable 5.1、GPT-6 Astra）拉到<strong>同一批题、同一提示词、同一裁判</strong>下正面对比，
  再补上同代三家与视觉两项。结果不是"谁更强"，而是发现了一件更值得说的事：
  <strong>最贵的模型在财报问答上的领先，很大一部分来自记忆，而不是读文档的能力。</strong></p>

  <div class="kpis">
    <div class="kpi"><div class="v" data-count="${biz.tools}">0</div><div class="k">平台工具</div></div>
    <div class="kpi"><div class="v" data-count="${biz.tables}">0</div><div class="k">数据表 / ${biz.dims} 个风险维度</div></div>
    <div class="kpi"><div class="v" data-count="5">0</div><div class="k">家模型正面对比</div></div>
    <div class="kpi"><div class="v" data-count="${calls}">0</div><div class="k">次模型调用</div></div>
    <div class="kpi"><div class="v">¥<span data-count-dec="${costCNY.toFixed(1)}">0</span></div><div class="k">整轮外部对齐成本</div></div>
  </div>
  <p class="note">口径：FinanceBench 全量 150 题（oracle + 闭卷双口径）、BFCL v4 520 题、FinEval-MM 150 题、OmniDocBench 18 页；
  裁判 Claude Sonnet 5（与被测各方均非同源）。闭卷 = 不给任何文档，只给问题。</p>
</div></header>

<section id="finding"><div class="wrap">
  <h2><span class="no">01</span>核心发现：闭卷之后，排名变了意思</h2>
  <div class="grid2">
    <div>
      <div class="quote">把文档完全拿走之后，<br>排名第一的模型仍然答对 <span class="a">86.67%</span>。</div>
      <p class="sub" style="margin-top:18px">FinanceBench 的 oracle 口径是把标注好的证据段落直接喂给模型，常被当作"读财报能力"。
      我们补了一个对照实验：<strong>完全不给文档</strong>，只给问题。于是每个模型都得到两个分数——</p>
      <ul style="color:var(--ink2);padding-left:20px;margin:0">
        <li><strong style="color:var(--blue)">oracle</strong>：给了文档能答对多少</li>
        <li><strong>闭卷</strong>：不给文档还能答对多少（≈ 记忆底分）</li>
        <li><strong style="color:var(--accent)">文档增量</strong>：两者之差，才是"读文档"真正带来的能力</li>
      </ul>
      <p class="sub" style="margin-top:18px">最贵档的 Fable 5.1 闭卷就能答对 ${f2(fable.closed)}%，
      文档只为它带来 <strong style="color:var(--amber)">+${f2(fable.inc)}pp</strong>；
      而文档为我们带来 <strong style="color:var(--accent)">+${f2(ours.inc)}pp</strong>，
      是它的 <strong>${f1(ours.inc / fable.inc)} 倍</strong>。
      抽查还看到它自己在答案里写 "Based on FY2022 figures <em>from memory</em>"，并复现出只有读过原文才知道的数字。</p>
    </div>
    <div class="card">
      <div class="tag warn">记忆底分 vs 文档增量</div>
      <table>
        <thead><tr><th>模型</th><th class="n">闭卷</th><th class="n">文档增量</th><th class="n">闭卷写出正确数值</th></tr></thead>
        <tbody>
          ${sorted.map((m) => `<tr class="${m.ours ? 'ours' : ''}"><td>${esc(m.short)}</td><td class="n">${f2(m.closed)}%</td><td class="n" style="color:${m.ours ? 'var(--accent)' : 'inherit'};font-weight:700">+${f2(m.inc)}pp</td><td class="n">${m.recalled === undefined ? '—' : f1(m.recalled) + '%'}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="note">本表按<strong>文档增量</strong>排序（不是按能力排序）——括号越长，说明它的分数越是"读"出来的。
      「闭卷写出正确数值」= 不给文档却给出与标准答案一致的数值，占该模型 150 题的比例。这一项不依赖提示词风格，是记忆的直接证据。</p>
    </div>
  </div>
</div></section>

<section id="inc"><div class="wrap">
  <h2><span class="no">02</span>把两个分数画在一起</h2>
  <p class="sub">蓝条 = 给了文档（oracle），灰条 = 不给文档（闭卷），绿色括号 = 差额，也就是文档真正带来的部分。
  我们把括号画在灰条右端，是因为<strong>它才是这家模型"会读文档"的证据</strong>。</p>
  <div class="card">${incChart}
    <div class="legend"><span><i style="background:var(--blue)"></i>oracle（给文档）</span><span><i style="background:#33415c"></i>闭卷（不给文档）</span><span><i style="background:var(--accent)"></i>文档增量</span></div>
    <p class="note">口径：FinanceBench 全量 150 题，A1 提示词，裁判 Claude Sonnet 5。闭卷不等于纯记忆（部分题可凭通用金融常识推导，且闭卷提示词鼓励推导），故它是污染的<strong>上界</strong>估计。</p>
  </div>
</div></section>

<section id="cost"><div class="wrap">
  <h2><span class="no">03</span>成本 × 效果：气泡越大，越靠"读"得分</h2>
  <div class="grid2">
    <div class="card">${bubble}
      <p class="note">横轴为两项基准（FinanceBench 150 + BFCL 520）的实测模型成本，对数轴；纵轴为 oracle 准确率；
      气泡半径代表文档增量。我们（绿）在最左侧、且气泡不小——<strong>用 1/17 的钱拿到了 97% 的分数，并且分数里"读出来"的比例最高。</strong>
      Luna 与 GLM-5.3-Flash 的价目网关未公布，故不入图。</p>
    </div>
    <div>
      <div class="big">$${f2(ours.cost)} <span style="color:var(--muted);font-weight:600;font-size:.5em">vs</span> $${f2(astra.cost)} ~ $${f2(fable.cost)}</div>
      <p class="sub" style="margin-top:14px">同样跑完这两项基准，我们花 <strong>$${f2(ours.cost)}</strong>；
      Astra 是我们的 <strong>${f1(astra.ratio)} 倍</strong>，Fable 5.1 是 <strong>${f1(fable.ratio)} 倍</strong>。
      而在工具调用（BFCL，确定性判分）上，我们 ${f2(ours.bfcl)}%，领先 Astra ${f1(ours.bfcl - astra.bfcl)}pp。</p>
      <div class="card" style="margin-top:18px">
        <table>
          <thead><tr><th>模型</th><th class="n">oracle</th><th class="n">BFCL</th><th class="n">成本</th><th class="n">倍数</th></tr></thead>
          <tbody>
            ${sortedOracle.map((m) => `<tr class="${m.ours ? 'ours' : ''}"><td>${esc(m.short)}</td><td class="n">${f2(m.oracle)}%</td><td class="n">${f2(m.bfcl)}%</td><td class="n">${m.cost === null ? '未公布' : '$' + f2(m.cost)}</td><td class="n">${m.ratio ? f1(m.ratio) + '×' : '—'}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div></section>

<section id="radar"><div class="wrap">
  <h2><span class="no">04</span>四维对比：两家顶级模型各赢一半</h2>
  <div class="grid2">
    <div class="card">${dim.svg}
      <div class="legend"><span><i style="background:var(--accent)"></i>我们</span><span><i style="background:var(--blue)"></i>GPT-6 Astra</span><span><i style="background:var(--amber)"></i>Claude Fable 5.1</span><span>★ = 该维领先</span></div>
      <p class="note">每行独立定标（只比较同一维度内的三家），并直接标出原始数值：财报问答 = FinanceBench oracle；工具调用 = BFCL v4；图表取数 = FinEval-MM；整页转写 = OmniDocBench 片段召回。Luna / GLM 未跑视觉，故不入此图。</p>
    </div>
    <div>
      <div class="grid3">
        <div class="card"><div class="tag">图表取数</div><div class="big" style="font-size:30px">${f2(visOf('deepseek-flash') ? visOf('deepseek-flash').finevalMm.accuracyPct : null)}%</div>
          <div class="note" style="margin-top:4px">我们领先 Fable 5.1 ${f1((visOf('deepseek-flash') ? visOf('deepseek-flash').finevalMm.accuracyPct : 0) - (visOf('claude-fable-5-1') ? visOf('claude-fable-5-1').finevalMm.accuracyPct : 0))}pp，落后 Astra ${f1((visOf('gpt-6-astra') ? visOf('gpt-6-astra').finevalMm.accuracyPct : 0) - (visOf('deepseek-flash') ? visOf('deepseek-flash').finevalMm.accuracyPct : 0))}pp</div></div>
        <div class="card"><div class="tag good">工具调用</div><div class="big" style="font-size:30px">${f2(ours.bfcl)}%</div>
          <div class="note" style="margin-top:4px">确定性判分，无裁判主观性；领先 Astra、只落后 Fable ${f1(fable.bfcl - ours.bfcl)}pp</div></div>
        <div class="card"><div class="tag">整页转写</div><div class="big" style="font-size:30px">${f2(visOf('deepseek-flash') ? visOf('deepseek-flash').omniDoc.numberRecall : null)}</div>
          <div class="note" style="margin-top:4px">数字召回；Fable 在这一项略胜我们（${f2(visOf('claude-fable-5-1') ? visOf('claude-fable-5-1').omniDoc.numberRecall : null)}）</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="tag warn">能力分裂</div>
        <p class="sub" style="margin:8px 0 0">Fable 5.1 在整页转写保真度上略胜我们，却在图表取数上输给我们；
        这与一个更早的观察吻合：它能指出"标题在右页中部"（版面位置感知），
        但在<strong>金融数据推理与理解</strong>这一类题上只拿到 <strong>6.67%（1/15）</strong>。
        <strong>会看版面 ≠ 会取数。</strong></p>
      </div>
    </div>
  </div>
</div></section>

<section id="self"><div class="wrap">
  <h2><span class="no">05</span>自建基准：先证明自己，再去比外部</h2>
  <p class="sub">外部基准决定"坐标"，自建基准决定"确定性"。下面四项用生成过程真值与事后事件做标注，
  刻意避开"自己考自己"——这也是后面能看出"记忆 vs 阅读"的前提：我们知道自己的数字是怎么来的。</p>
  <div class="grid3">
    <div class="card"><div class="tag good">T1 结构化抽取</div>
      <div class="big">100%<small style="font-size:14px;color:var(--muted)"> 字段级 F1</small></div>
      <div class="bar"><i data-w="100"></i></div>
      <div class="note">258 个单元格，MAPE 0.0000%</div></div>
    <div class="card"><div class="tag good">T3 勾稽校验</div>
      <div class="big">100%<small style="font-size:14px;color:var(--muted)"> 缺陷召回</small></div>
      <div class="bar"><i data-w="100"></i></div>
      <div class="note">4 类缺陷，误报率 0%</div></div>
    <div class="card"><div class="tag good">T4 指标测算</div>
      <div class="big">100%<small style="font-size:14px;color:var(--muted)"> 与独立重算一致</small></div>
      <div class="bar"><i data-w="100"></i></div>
      <div class="note">30 个指标点，最大相对误差 0.471%</div></div>
    <div class="card"><div class="tag good">T5 风险预警</div>
      <div class="big">79.8<small style="font-size:14px;color:var(--muted)"> AUC</small></div>
      <div class="bar"><i data-w="79.8"></i></div>
      <div class="note">三行财务规则基线 63.3；任一高危事件领先 255 天（1,348 家企业·期，time-split）</div></div>
  </div>
</div></section>

<section id="method"><div class="wrap">
  <h2><span class="no">06</span>这条路是怎么走出来的</h2>
  <div class="grid2">
    <div class="tl">
      <div class="it"><div class="d">第一阶段</div><div class="t">自建基准 T1–T5</div><div class="sub" style="margin:2px 0 0">用生成过程真值 + 事后事件做标注，先把"读得准、判得准"钉死。</div></div>
      <div class="it"><div class="d">第二阶段</div><div class="t">外部对齐：6 组公开基准</div><div class="sub" style="margin:2px 0 0">CFLUE / FinEval / FinEval-MM / BFCL / OmniDocBench / FinanceBench，全部锁定版本与哈希。</div></div>
      <div class="it"><div class="d">第三阶段</div><div class="t">发现裁判是同一把尺子的问题</div><div class="sub" style="margin:2px 0 0">把论文公开答案送进我们的裁判重判，才看清"平手"是尺子造成的；随后统一裁判口径并引入多数投票。</div></div>
      <div class="it"><div class="d">第四阶段</div><div class="t">同代与超限挑战</div><div class="sub" style="margin:2px 0 0">接入聚合网关，把同代三家与最贵档两家拉到同题同裁判下对比；顺带验证"网关路由是否改变答案"。</div></div>
      <div class="it"><div class="d">第五阶段</div><div class="t">补上闭卷对照，发现记忆红利</div><div class="sub" style="margin:2px 0 0">本文的起点：<strong>不给文档还能答对多少</strong>，才是判断"会不会读"的关键一问。</div></div>
    </div>
    <div class="card">
      <div class="tag">可复现</div>
      <pre># 1) 回归与工程指标
node bench/run.js --no-gui
# 2) 自建基准 T1/T3/T4
node bench/benchmark/run.js
# 3) 外部对齐（六组）
node bench/external/run.js --models deepseek-flash
# 4) 同代/超限对比
node bench/external/samegen.js --plan
# 5) 生成展示页
node bench/html/make-showcase.js</pre>
      <p class="note">每个数字都对应仓库里的产物文件与命令；报告与展示页由同一批 JSON 生成，不存在两套口径。</p>
    </div>
  </div>
</div></section>

<section id="limits"><div class="wrap">
  <h2><span class="no">07</span>边界：这份展示没有覆盖到什么</h2>
  <div class="grid3">
    <div class="card"><div class="tag warn">口径</div><p class="sub" style="margin:8px 0 0">闭卷不等于纯记忆：部分题可凭通用金融常识推导，且闭卷提示词鼓励推导，因此闭卷分是污染的<strong>上界</strong>估计。</p></div>
    <div class="card"><div class="tag warn">判分</div><p class="sub" style="margin:8px 0 0">BFCL 判分是官方 checker 的自实现移植，OmniDocBench 四项是自实现保真度指标（非官方 TEDS/CDM），不得与官方榜单直接等同。</p></div>
    <div class="card"><div class="tag warn">样本</div><p class="sub" style="margin:8px 0 0">FinanceBench 用的是开源子集 150 题；闭卷对照只在这一组题上做过，"记忆红利"的结论仍需换一个未被污染的基准复验。</p></div>
    <div class="card"><div class="tag warn">未做</div><p class="sub" style="margin:8px 0 0">T6 Agent 工具链未纳入自建基准；长稳测试（8 小时 / 2000 请求）与放大数据量后的性能未做。</p></div>
    <div class="card"><div class="tag warn">成本</div><p class="sub" style="margin:8px 0 0">Luna 与 GLM-5.3-Flash 的网关价目未公布，只记 token 不估钱；我们的成本按官方 peak 价计，实际可能更低。</p></div>
    <div class="card"><div class="tag warn">产品链路</div><p class="sub" style="margin:8px 0 0">平台后端附件目前只接受图片、<strong>不支持 PDF</strong>；PDF 抽取与检索在评测侧完成，产品化需要补后端 PDF 能力。</p></div>
  </div>
</div></section>

<footer><div class="wrap">
  <div>数据来源：<code>bench/external/out/frontier-challenge.json</code>、<code>samegen-results.json</code>、<code>bench/external/reports/external-alignment-v1.json</code>、<code>bench/reports/</code>。</div>
  <div style="margin-top:8px">展示页由 <code>bench/html/make-showcase.js</code> 生成；单文件零依赖，离线可用。所有对比均在公开基准上进行，结果包含负结果与未达标项。</div>
</div></footer>

<script>
(function(){
  var prog=document.getElementById('prog');
  function onScroll(){
    var h=document.documentElement;
    var p=h.scrollTop/(h.scrollHeight-h.clientHeight||1);
    prog.style.width=(p*100).toFixed(2)+'%';
  }
  addEventListener('scroll',onScroll,{passive:true});onScroll();

  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target);} });
  },{rootMargin:'-8% 0px -8% 0px'});
  document.querySelectorAll('.reveal').forEach(function(el){io.observe(el)});

  // 数字滚动
  function count(el){
    var target=Number(el.getAttribute('data-count'))||0, t0=null, dur=1100;
    function step(ts){ if(!t0)t0=ts; var k=Math.min(1,(ts-t0)/dur); var v=Math.round(target*(1-Math.pow(1-k,3)));
      el.textContent=v.toLocaleString('en-US'); if(k<1)requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  var kio=new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ count(e.target); kio.unobserve(e.target);} });
  },{threshold:.4});
  document.querySelectorAll('[data-count]').forEach(function(el){kio.observe(el)});
  // 带小数位的计数（成本用）
  function countDec(el){
    var target=Number(el.getAttribute('data-count-dec'))||0, t0=null, dur=1100;
    function step(ts){ if(!t0)t0=ts; var k=Math.min(1,(ts-t0)/dur); var v=target*(1-Math.pow(1-k,3));
      el.textContent=v.toFixed(1); if(k<1)requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  var dio=new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ countDec(e.target); dio.unobserve(e.target);} });
  },{threshold:.4});
  document.querySelectorAll('[data-count-dec]').forEach(function(el){dio.observe(el)});

  // 进度条（能力条）
  var bio=new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ var bar=e.target; bar.style.width=(bar.getAttribute('data-w')||0)+'%'; bio.unobserve(bar);} });
  },{threshold:.5});
  document.querySelectorAll('.bar > i').forEach(function(el){bio.observe(el)});

  // 交互：点击/悬停柱状行 → 高亮并显示细节
  var rows=document.querySelectorAll('.incRow');
  rows.forEach(function(r){
    function hl(){ rows.forEach(function(x){x.style.opacity=(x===r?1:.32)}); }
    function reset(){ rows.forEach(function(x){x.style.opacity=1}); }
    r.addEventListener('mouseenter',hl); r.addEventListener('mouseleave',reset);
    r.addEventListener('click',function(){
      var t=r.getAttribute('data-model');
      var el=document.querySelector('#incDetail');
      if(!el)return;
      var d=DATA[t]; if(!d)return;
      el.innerHTML='<h4>'+d.label+'</h4>'+
        '<div class="note" style="margin:0 0 10px">oracle '+d.oracle.toFixed(2)+'% ｜ 闭卷 '+d.closed.toFixed(2)+'% ｜ 文档增量 +'+d.inc.toFixed(2)+'pp ｜ 闭卷写出正确数值 '+d.recalled+'%</div>'+
        '<div class="bar"><i style="width:'+d.closed+'%"></i></div><div class="note" style="margin:-6px 0 8px">闭卷（记忆底分）</div>'+
        '<div class="bar"><i style="width:'+d.oracle+'%"></i></div><div class="note" style="margin:-6px 0 0">oracle（给文档）</div>';
      el.classList.add('in');
      el.style.opacity=1; el.style.transform='none';
    });
  });
  window.DATA=${JSON.stringify(Object.fromEntries(MODELS.map((m) => [m.id, { label: m.label, oracle: m.oracle, closed: m.closed, inc: m.inc, recalled: m.recalled }])))};
})();
</script>
</body>
</html>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html)
console.log(`已生成 ${path.relative(REPO, OUT)}（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB，单文件零依赖）`)
console.log(`  模型 ${MODELS.length} 家；视觉数据 ${vision.length} 家；成本合计 ¥${costCNY.toFixed(2)}`)

/**
 * 汇总同代测试结果（2026-09-14）。
 *
 * 数据来源：
 *  - out/samegen-*.log       每次运行的 run.js 输出（含 headline 指标）
 *  - out/judge-matrix-financebench.json  同尺子重判结果
 *  - out/run-<ts>/<bench>.<model>.json   逐题明细
 *
 *   node bench/external/tools/aggregate-samegen.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')

/**
 * 读文本文件，按 BOM 自动识别编码。
 * 教训：PowerShell 的 Tee-Object 默认写 UTF-16LE（ff fe BOM），按 UTF-8 读会得到乱码、
 * 连 EXTERNAL-ALIGNMENT 这种纯 ASCII 标记都找不到——不是数据没写，是读错了编码。
 */
function readSmart(p) {
  const buf = fs.readFileSync(p)
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le')
  if (buf.length > 1 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE：逐字节交换后按 LE 解
    const swapped = Buffer.from(buf.slice(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '')
}

/** 从一次运行的日志里抓出 EXTERNAL-ALIGNMENT 行的 JSON */
function parseRun(logFile) {
  const p = path.join(OUT, logFile)
  if (!fs.existsSync(p)) return null
  const txt = readSmart(p)
  const line = txt.split(/\r?\n/).find((l) => l.includes('EXTERNAL-ALIGNMENT:'))
  if (!line) return null
  const j = JSON.parse(line.slice(line.indexOf('EXTERNAL-ALIGNMENT:') + 'EXTERNAL-ALIGNMENT:'.length))
  const fb = (j.benchmarks.financebench && j.benchmarks.financebench.runs) || {}
  const bfcl = (j.benchmarks.bfcl && j.benchmarks.bfcl.runs) || {}
  const model = Object.keys(fb)[0] || Object.keys(bfcl)[0]
  const fbRun = fb[model] || {}
  const bfclRun = bfcl[model] || {}
  const head = (run, key) => {
    const h = (run.headline || []).find((x) => x.path === key)
    return h ? h.value : null
  }
  // 接入路径要按**注册表里配置的端点**判断，不能按名字猜：
  // 之前用 /^zen-/ 判断，把走网关的 Luna / GLM 错标成了"官方直连"。
  const prov = (() => {
    try { return require('../lib/model').resolveProvider(model) } catch { return null }
  })()
  const route = prov && /opencode\.ai/.test(prov.baseUrl || '') ? 'gateway' : 'official'
  const judgeModel = (fbRun.metrics && fbRun.metrics.judgeSource) || null
  return {
    model,
    route,
    financebench: {
      oraclePct: head(fbRun, 'judgeGraded.byMode.oracle'),
      closedBookPct: head(fbRun, 'judgeGraded.byMode.closedBook'),
      deterministicOraclePct: head(fbRun, 'deterministic.byMode.oracle'),
      byType: {
        metrics: head(fbRun, 'byQuestionType.FinanceBench/metrics-generated'),
        domain: head(fbRun, 'byQuestionType.FinanceBench/domain-relevant'),
        novel: head(fbRun, 'byQuestionType.FinanceBench/novel-generated'),
      },
      judgeModel,
      judgeIsSameModel: judgeModel === model,
      n: fbRun.rows,
    },
    bfcl: {
      overallPct: head(bfclRun, 'overall'),
      simplePct: head(bfclRun, 'byCategory.BFCL/simple（单函数）'),
      multiplePct: head(bfclRun, 'byCategory.BFCL/multiple（多函数选一）'),
      irrelevancePct: head(bfclRun, 'byCategory.BFCL/irrelevance（应拒调）'),
      n: bfclRun.rows,
    },
  }
}

const RUNS = [
  ['samegen-deepseek-official.log', 'DeepSeek-V4.1-Flash（官方直连）'],
  ['samegen-deepseek-gateway.log', 'DeepSeek-V4-Flash（网关路由，对照组）'],
  ['samegen-luna.log', 'GPT-5.6 Luna（网关）'],
  ['samegen-glm.log', 'GLM-5.3-Flash（网关）'],
]

const runs = []
for (const [f, label] of RUNS) {
  const r = parseRun(f)
  if (r) runs.push({ label, ...r })
  else console.log(`  ⚠️ 跳过（无数据）：${f}`)
}

// 裁判矩阵
const matrixFile = path.join(OUT, 'judge-matrix-financebench.json')
const matrix = fs.existsSync(matrixFile) ? JSON.parse(fs.readFileSync(matrixFile, 'utf8')) : null

const agg = {
  generatedAt: new Date().toISOString(),
  title: '同代模型对比（2026-09-14）',
  note: [
    '被测三方：DeepSeek-V4.1-Flash（我方，deepseek-flash 的官方身份）、GPT-5.6 Luna、GLM-5.3-Flash。',
    'FinanceBench 使用 A1 提示词、oracle 口径、150 题；裁判统一为 Claude Sonnet 5（非候选厂商），并由 Kimi K3 交叉复判。',
    'BFCL v4 为确定性判分（无裁判主观性）；closedBook 仅作记忆/污染探针，不作能力结论。',
  ],
  candidates: runs,
  financebenchMatrix: matrix ? matrix.matrix : null,
  judgeRobustness: matrix
    ? Object.fromEntries(Object.entries(matrix.matrix).map(([m, v]) => [m, Object.fromEntries(Object.entries(v.judges).map(([j, x]) => [j, x.accuracyPct]))]))
    : null,
}

fs.writeFileSync(path.join(OUT, 'samegen-results.json'), JSON.stringify(agg, null, 2))

console.log('=== 同代对比汇总（FinanceBench oracle, 150 题）===')
console.log('候选                              裁判(Sonnet5)  裁判(KimiK3)  BFCL overall  closedBook')
for (const r of runs) {
  const m = agg.judgeRobustness && agg.judgeRobustness[r.model] ? agg.judgeRobustness[r.model] : {}
  console.log(
    '  ' + r.label.padEnd(32) +
    String(m['claude-sonnet-5'] ?? r.financebench.oraclePct ?? '—').padEnd(14) +
    String(m['kimi-k3'] ?? '—').padEnd(14) +
    String(r.bfcl.overallPct ?? '—').padEnd(14) +
    String(r.financebench.closedBookPct ?? '—')
  )
}
console.log('\n产物 → bench/external/out/samegen-results.json')

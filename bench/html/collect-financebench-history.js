/**
 * 汇总 FinanceBench 的"改进前 / 改进后"记录，供报告引用。
 *
 * 为什么要单独落一份历史：
 *  - 官方产物 external-alignment-v1.json 只保留**最新一次**运行（改进后），
 *    改进前的 82.0% 若不显式留档，就会变成"只在提交历史里能查到"的数字；
 *  - 本文所有变体实验、裁判校准、冻结切分验证都必须能一条命令复查。
 *
 *   node bench/html/collect-financebench-history.js
 */
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const EXT = path.join(REPO, 'bench', 'external')
const OUT = path.join(EXT, 'out', 'financebench-history.json')

const TYPES = ['metrics-generated', 'domain-relevant', 'novel-generated']
const stats = (rows) => {
  const ok = rows.filter((r) => !r.error && r.grade)
  const byType = {}
  for (const t of TYPES) byType[t] = { n: 0, correct: 0 }
  let correct = 0
  const verdicts = {}
  for (const r of ok) {
    const v = r.grade.judge
    verdicts[v] = (verdicts[v] || 0) + 1
    if (v === 'CORRECT') correct++
    const t = TYPES.includes(r.group ? String(r.group).replace('FinanceBench/', '') : r.type) ? (r.group ? String(r.group).replace('FinanceBench/', '') : r.type) : null
    if (t) {
      byType[t].n++
      if (v === 'CORRECT') byType[t].correct++
    }
  }
  return {
    n: ok.length,
    correct,
    accuracyPct: ok.length ? Number(((correct / ok.length) * 100).toFixed(2)) : null,
    verdicts,
    byType: Object.fromEntries(TYPES.map((t) => [t, { n: byType[t].n, accuracyPct: byType[t].n ? Number(((byType[t].correct / byType[t].n) * 100).toFixed(2)) : null }])),
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  note: 'FinanceBench oracle 口径的改进记录：A0=原提示词（含拒答邀请），A1=去保守化；均由同一个裁判（deepseek-flash）判定。',
  variants: {},
}

// 1) 历次正式运行的明细：**全部记录**（同一变体跑多次也逐次记录，用于展示运行间波动）
const runsDir = path.join(EXT, 'out')
const history = []
for (const d of fs.readdirSync(runsDir).filter((x) => x.startsWith('run-')).sort()) {
  const f = path.join(runsDir, d, 'financebench.deepseek-flash.json')
  if (!fs.existsSync(f)) continue
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  const variant = (j.metrics && j.metrics.promptVariant) || 'A0'
  const s = stats(j.rows.filter((r) => r.mode === 'oracle'))
  history.push({
    variant,
    runDir: d,
    judgeModel: (j.metrics && j.metrics.judgeGraded && j.metrics.judgeGraded.judgeModel) || 'deepseek-flash',
    ...s,
    source: path.relative(REPO, f).replace(/\\/g, '/'),
  })
}
out.runs = history
// 每个变体取**最新一次**作为代表，同时保留全部运行用于看波动
for (const v of [...new Set(history.map((h) => h.variant))]) {
  const all = history.filter((h) => h.variant === v)
  const last = all[all.length - 1]
  out.variants[`${v}（最新一次）`] = {
    label: v === 'A1' ? 'A1 去保守化提示词' : 'A0 原提示词（含「无法确定就拒答」）',
    ...last,
    timesRun: all.length,
    accuracySpreadPct: [Math.min(...all.map((x) => x.accuracyPct)), Math.max(...all.map((x) => x.accuracyPct))],
  }
}
out.driftNote = '同一提示词多次运行之间会有 1~3 个百分点的波动（temperature=0 也不完全确定），因此分数只用于判断量级与方向。'

// 2) 实验产物（dev/test 分开的那些）；同一 (变体, 切分) 只取一份，优先 judge@3 重判版本
const expDir = path.join(EXT, 'out', 'experiments')
if (fs.existsSync(expDir)) {
  const pick = new Map()
  for (const f of fs.readdirSync(expDir).filter((x) => x.endsWith('.json')).sort()) {
    const m = f.match(/^exp-([A-Za-z0-9]+)-(dev|test)-/)
    if (!m) continue
    const key = `${m[1]}-${m[2]}`
    const isRejudge = /-rejudge\d+\.json$/.test(f)
    const prev = pick.get(key)
    if (!prev || (isRejudge && !prev.isRejudge)) pick.set(key, { f, isRejudge })
  }
  for (const { f, isRejudge } of pick.values()) {
    const j = JSON.parse(fs.readFileSync(path.join(expDir, f), 'utf8'))
    const key = `${j.variant}-${j.split}`
    const rows = (j.rows || []).map((r) => ({ group: `FinanceBench/${r.type}`, grade: { judge: r.judge }, error: r.error }))
    out.variants[key] = {
      label: j.label,
      split: j.split,
      judgeVotes: j.judgeVotes || 1,
      rejudged: isRejudge,
      ...stats(rows),
      baselinePctOnSameIds: j.baselinePct,
      deltaQuestions: j.deltaQuestions,
      source: path.relative(REPO, path.join(expDir, f)).replace(/\\/g, '/'),
    }
  }
}

// 3) 冻结切分
const splitFile = path.join(EXT, 'out', 'financebench-split.json')
if (fs.existsSync(splitFile)) {
  const s = JSON.parse(fs.readFileSync(splitFile, 'utf8'))
  out.split = { createdAt: s.createdAt, rule: s.rule, dev: s.dev.length, test: s.test.length, hash: s.hash }
}

// 4) 裁判校准
const jp = path.join(EXT, 'out', 'judge-published.json')
if (fs.existsSync(jp)) {
  const j = JSON.parse(fs.readFileSync(jp, 'utf8'))
  out.judgeCalibration = {
    judgeModel: j.judgeModel && j.judgeModel.model,
    note: '把论文公开答案送进我们的裁判重判：差值说明两套裁判的宽严差异，不改变任何一方的答案质量。',
    rows: (j.results || []).map((r) => ({ label: r.label, n: r.n, paperAccuracyPct: r.paperAccuracyPct, ourJudgeAccuracyPct: r.ourJudgeAccuracyPct, deltaPp: r.deltaPp, changedToWrong: r.changedToWrong, changedToCorrect: r.changedToCorrect })),
  }
}

// 5) 同一裁判（多数投票）下的变体横向对比
const vc = path.join(EXT, 'out', 'variant-comparison.json')
if (fs.existsSync(vc)) {
  const j = JSON.parse(fs.readFileSync(vc, 'utf8'))
  out.variantComparison = {
    note: '单次裁判在 n=60 上有 ±2~3 题噪声（诊断中发现同一份数字答案会被判成不同结论），因此全部变体的存量答案用 judge@3 多数投票重判后再比较。',
    judgeVotes: j.judgeVotes,
    split: j.split,
    rows: j.results.filter((r) => r.pct !== undefined).map((r) => ({ variant: r.variant, correct: r.correct, n: r.n, accuracyPct: r.pct, byType: r.byType })),
  }
}

// 6) B1 证据结构化的实现指标（覆盖率 + 硬约束）
try {
  const { execFileSync } = require('node:child_process')
  const txt = execFileSync('node', [path.join(REPO, 'bench', 'html', 'check-restructure.js')], { cwd: REPO, encoding: 'utf8' })
  const pick = (re) => { const m = txt.match(re); return m ? Number(m[1]) : null }
  out.b1Restructure = {
    note: '确定性重排：把"标签 + 若干数字行"按期间表头对齐成 Markdown 表；硬约束是"数字不许丢、不许编造"。',
    coveragePct: pick(/产出至少 1 张表的证据：\d+（([\d.]+)%）/),
    tables: pick(/共生成表格 (\d+) 张/),
    tableRows: pick(/表格行 (\d+) 行/),
    invariantFailures: pick(/硬约束（数字多重集一致）\*\*：失败 (\d+) 条/),
    charRatioPct: pick(/结构化后 \d+（([\d.]+)%）/),
  }
} catch (e) {
  out.b1Restructure = { error: String(e.message).slice(0, 120) }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`已写出 ${path.relative(REPO, OUT)}\n`)
for (const [k, v] of Object.entries(out.variants)) {
  console.log(`${k.padEnd(12)} n=${v.n} 准确率 ${v.accuracyPct}%  分题型 ${TYPES.map((t) => `${t.slice(0, 6)}=${v.byType[t].accuracyPct}%`).join(' ')}`)
}
if (out.judgeCalibration) {
  console.log('\n裁判校准：')
  for (const r of out.judgeCalibration.rows) console.log(`  ${r.label.padEnd(22)} 论文 ${r.paperAccuracyPct}% → 我们裁判 ${r.ourJudgeAccuracyPct}%（${r.deltaPp}pp）`)
}

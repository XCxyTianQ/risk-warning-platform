/**
 * bench/lib/report.js —— 报告生成与基线比对。
 *
 * 两份产物：
 *   bench/report/bench-report.json  机器可读（CI 归档、以后画趋势图）
 *   bench/report/bench-report.md    人可读（贴进汇报/答辩材料）
 *
 * 基线（bench/baseline.json）是"上一次公认良好的数字"，用来发现**退化**：
 * 门禁只拦两类事——套件由通过变失败、断言通过数下降；其余（时延/包体/耗时变差）
 * 记 warning 但不拦，避免把开发卡死。
 */
const fs = require('node:fs')
const path = require('node:path')

const HARNESS = { name: 'rwp-bench', version: '0.1.0', schema: 1 }

const STATUS_ICON = { pass: '✅', fail: '❌', error: '💥', skipped: '⏭️' }

function summarize(suites, platform) {
  const s = { pass: 0, fail: 0, error: 0, skipped: 0 }
  let checksPassed = 0
  let checksFailed = 0
  let infoMissed = 0
  let extendedFailed = 0
  for (const suite of suites) {
    if (suite.status === 'pass') s.pass++
    else if (suite.status === 'fail' || suite.status === 'error') {
      // 门禁（gate）失败才判红；extended 依赖外网/模型，失败会列出但不拦
      if ((suite.tier || 'gate') === 'extended') extendedFailed++
      else if (suite.status === 'fail') s.fail++
      else s.error++
    } else s.skipped++
    checksPassed += suite.checksPassed || 0
    checksFailed += suite.checksFailed || 0
  }
  // 平台检查分两级：gate（门禁，失败即红）与 info（v1 目标，未达标只记账）
  for (const c of (platform && platform.checks) || []) {
    if (c.ok) checksPassed++
    else if (c.severity === 'info') infoMissed++
    else checksFailed++
  }
  return {
    suites: { total: suites.length, ...s, extendedFailed },
    checks: { passed: checksPassed, failed: checksFailed, infoMissed },
    status: s.fail + s.error > 0 || checksFailed > 0 ? 'fail' : 'pass',
  }
}

function snapshot(report) {
  return {
    at: report.run.finishedAt,
    git: report.git.short,
    appVersion: report.env.appVersion,
    checksPassed: report.summary.checks.passed,
    checksFailed: report.summary.checks.failed,
    suites: Object.fromEntries(
      report.suites.map((s) => [s.id, { status: s.status, checksPassed: s.checksPassed || 0, checksFailed: s.checksFailed || 0 }]),
    ),
    metrics: {
      coldStartMedianMs: report.platform?.metrics?.coldStart?.medianMs ?? null,
      apiP95Max: maxP95(report.platform?.metrics?.apiLatency),
      jsRawBytes: report.platform?.metrics?.bundles?.jsRawBytes ?? null,
      jsFiles: report.platform?.metrics?.bundles?.jsFiles ?? null,
      durationMs: report.run.durationMs,
    },
  }
}

function maxP95(apiLatency) {
  if (!apiLatency) return null
  const values = Object.values(apiLatency)
    .map((v) => v.p95)
    .filter((v) => typeof v === 'number')
  return values.length ? Math.max(...values) : null
}

function compare(current, baseline) {
  if (!baseline) return { available: false, regressions: [], warnings: [], deltas: {} }
  const regressions = []
  const warnings = []
  const deltas = {}

  // 只比较"两边都真正跑过"的套件：--only / --no-gui 这类子集运行不该被误判成回归
  const baseSuites = baseline.suites || {}
  const norm = (v) => (typeof v === 'string' ? { status: v, checksPassed: null } : v || {})
  let baseComparable = 0
  let nowComparable = 0
  let comparedSuites = 0

  for (const now of current.suites || []) {
    if (now.status === 'skipped') continue
    const was = norm(baseSuites[now.id])
    if (!was.status || was.status === 'skipped') continue
    comparedSuites++
    baseComparable += was.checksPassed || 0
    nowComparable += now.checksPassed || 0
    if (was.status === 'pass' && now.status !== 'pass') {
      regressions.push(`套件 ${now.id}：${was.status} → ${now.status}${now.reason ? '（' + now.reason + '）' : ''}`)
    }
  }

  deltas.comparedSuites = comparedSuites
  deltas.checksPassed = nowComparable - baseComparable
  if (comparedSuites > 0 && nowComparable < baseComparable) {
    regressions.push(`可比套件断言通过数下降：${baseComparable} → ${nowComparable}（${comparedSuites} 个套件）`)
  }

  // 变差提醒要同时满足"相对倍数"和"绝对增量"：否则 1ms → 2ms 这种噪声会天天报警，没人会再看
  const num = (a, b, label, factor, minAbsDelta = 0) => {
    if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return
    const ratio = a / b
    const absDelta = a - b
    deltas[label] = { from: b, to: a, ratio: Number(ratio.toFixed(2)), absDelta: Number(absDelta.toFixed(2)) }
    if (ratio > factor && absDelta >= minAbsDelta) {
      warnings.push(`${label} 变差：${b} → ${a}（×${ratio.toFixed(2)}）`)
    }
  }
  num(current.platform?.metrics?.coldStart?.medianMs, baseline.metrics?.coldStartMedianMs, '冷启动中位数(ms)', 1.5, 200)
  num(maxP95(current.platform?.metrics?.apiLatency), baseline.metrics?.apiP95Max, '接口 p95 最差值(ms)', 1.5, 20)
  num(current.platform?.metrics?.bundles?.jsRawBytes, baseline.metrics?.jsRawBytes, '前端 JS 体积(bytes)', 1.1, 100 * 1024)
  // 整轮耗时只在套件集合一致时才有可比性
  const baseSuiteCount = Object.values(baseSuites).filter((v) => norm(v).status && norm(v).status !== 'skipped').length
  if (baseSuiteCount && baseSuiteCount === comparedSuites) {
    num(current.run?.durationMs, baseline.metrics?.durationMs, '整轮耗时(ms)', 2, 60000)
  }

  return { available: true, baselineAt: baseline.at, baselineGit: baseline.git, regressions, warnings, deltas }
}

function toMarkdown(report) {
  const L = []
  const s = report.summary
  L.push(`# 评测报告 · rwp-bench v${report.harness.version}`)
  L.push('')
  L.push(`> 运行时间：${report.run.startedAt} → ${report.run.finishedAt}（${(report.run.durationMs / 1000).toFixed(1)}s）`)
  L.push(`> 代码版本：\`${report.git.short}\`${report.git.dirty ? '（工作区有未提交改动）' : ''}　应用版本：v${report.env.appVersion}`)
  L.push(
    `> 模式：GUI ${report.run.mode.gui ? '开' : '关'} · 真实模型 ${report.run.mode.llm ? '开' : '关'} · Python 参考 ${report.run.mode.reference ? '开' : '关'}`,
  )
  L.push('')
  L.push(`## 总览：${s.status === 'pass' ? '✅ 通过' : '❌ 未通过'}`)
  L.push('')
  L.push('| 套件 | 通过 | 失败(门禁) | 失败(extended) | 错误 | 跳过 | 断言通过 | 断言失败 | 未达标(v1目标) |')
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  L.push(
    `| ${s.suites.total} | ${s.suites.pass} | ${s.suites.fail} | ${s.suites.extendedFailed || 0} | ${s.suites.error} | ${s.suites.skipped} | ${s.checks.passed} | ${s.checks.failed} | ${s.checks.infoMissed || 0} |`,
  )
  L.push('')
  L.push('> 门禁（gate）= 确定性套件，失败即判红；extended = 依赖外网/真实模型/参考实现，失败会列出但不拦路。')
  L.push('')

  const failed = report.suites.filter((x) => x.status === 'fail' || x.status === 'error')
  if (failed.length) {
    L.push('### 失败明细')
    L.push('')
    for (const f of failed) {
      L.push(`- **${f.id}**（exit=${f.exitCode}${f.timedOut ? '，超时' : ''}）${f.reason || ''}`)
      if (f.stderrTail) L.push(`  \`\`\`\n  ${String(f.stderrTail).trim().split('\n').slice(-6).join('\n  ')}\n  \`\`\``)
    }
    L.push('')
  }

  L.push('## 套件明细')
  L.push('')
  L.push('| 状态 | 套件 | 类型 | 级别 | 断言 | 耗时 | 关键指标 | 说明 |')
  L.push('|---|---|---|---|---:|---:|---|---|')
  for (const x of report.suites) {
    const checks = x.checksPassed || x.checksFailed ? `${x.checksPassed}✓${x.checksFailed ? `/${x.checksFailed}✗` : ''}` : '-'
    const m = x.metrics || {}
    const metricText = [
      m.comparisonPoints ? `金标准比对 ${m.comparisonPoints} 项 / 差异 ${m.diffs ?? 0}` : '',
      m.financeTolerancePct ? `数值容差 ${m.financeTolerancePct}%` : '',
      typeof m.compactCount === 'number' ? `压缩 ${m.compactCount} 次` : '',
      typeof m.llmCalls === 'number' ? `LLM 调用 ${m.llmCalls}` : '',
      typeof m.cacheHitRate === 'number' ? `缓存命中 ${(m.cacheHitRate * 100).toFixed(1)}%` : '',
      typeof m.agentSteps === 'number' ? `步数 ${m.agentSteps}` : '',
      typeof m.t1F1 === 'number' ? `T1 F1 ${(m.t1F1 * 100).toFixed(1)}%` : '',
      typeof m.t3Recall === 'number' ? `T3 召回 ${(m.t3Recall * 100).toFixed(1)}%` : '',
      typeof m.t4Agreement === 'number' ? `T4 一致 ${(m.t4Agreement * 100).toFixed(1)}%` : '',
      typeof m.t5Auc === 'number' ? `T5 AUC ${m.t5Auc.toFixed(3)}/AP ${(m.t5Ap ?? 0).toFixed(3)}` : '',
      typeof m.t5LeadDays === 'number' ? `预警期中位 ${m.t5LeadDays} 天` : '',
    ]
      .filter(Boolean)
      .join('，')
    L.push(
      `| ${STATUS_ICON[x.status] || '?'} | ${x.id} | ${x.kind} | ${x.tier || 'gate'} | ${checks} | ${(x.durationMs / 1000).toFixed(1)}s | ${metricText || '-'} | ${x.status === 'skipped' ? x.reason || '跳过' : x.title} |`,
    )
  }
  L.push('')

  if (report.platform) {
    const p = report.platform.metrics
    L.push('## 平台量化指标')
    L.push('')
    L.push('| 指标 | 实测 | 级别 | 结论 |')
    L.push('|---|---:|---|---|')
    for (const c of report.platform.checks) {
      L.push(`| ${c.name} | ${c.detail || '-'} | ${c.severity === 'info' ? 'v1 目标' : '门禁'} | ${c.ok ? '✅' : c.severity === 'info' ? '⚠ 未达标' : '❌'} |`)
    }
    if (p.apiLatency) {
      L.push('')
      L.push('### 只读接口时延（本机 localhost，n=25/接口）')
      L.push('')
      L.push('| 接口 | p50 | p95 | max |')
      L.push('|---|---:|---:|---:|')
      for (const [path, v] of Object.entries(p.apiLatency)) {
        L.push(`| \`${path}\` | ${v.p50}ms | ${v.p95}ms | ${v.max}ms |`)
      }
    }
    if (p.bundles) {
      L.push('')
      L.push('### 前端包体')
      L.push('')
      L.push('| 文件 | 原始 | gzip |')
      L.push('|---|---:|---:|')
      for (const b of p.bundles.items) {
        L.push(`| \`${b.file}\` | ${(b.rawBytes / 1024).toFixed(0)} KB | ${(b.gzipBytes / 1024).toFixed(0)} KB |`)
      }
    }
    L.push('')
  }

  const b = report.baseline
  L.push('## 基线比对')
  L.push('')
  if (!b || !b.available) {
    L.push('_无基线（首次运行用 `--update-baseline` 固化即可）_')
  } else {
    L.push(`基线来自 \`${b.baselineGit}\`（${b.baselineAt}）`)
    L.push('')
    if (b.regressions.length) {
      L.push('**回归**')
      L.push('')
      for (const r of b.regressions) L.push(`- ❌ ${r}`)
    } else {
      L.push('- ✅ 无回归（套件状态与断言数均未下降）')
    }
    if (b.warnings.length) {
      L.push('')
      L.push('**变差提醒（不拦截）**')
      L.push('')
      for (const w of b.warnings) L.push(`- ⚠ ${w}`)
    }
  }
  L.push('')

  L.push('## 运行环境')
  L.push('')
  L.push('```')
  L.push(`os        : ${report.env.platform} ${report.env.arch} (${report.env.osRelease}), ${report.env.cpus} cores / ${report.env.totalMemMB} MB`)
  L.push(`node      : ${report.env.node}`)
  L.push(`python    : ${report.env.python || '-'}`)
  L.push(`rust      : ${report.env.rustc || '-'}`)
  L.push(`后端二进制 : ${report.env.backendBinary.path} (${(report.env.backendBinary.sizeBytes / 1048576).toFixed(1)} MB, sha256 ${String(report.env.backendBinary.sha256).slice(0, 12)}…)`)
  L.push(`真实模型  : ${report.env.llm ? `${report.env.llm.baseUrl} · ${report.env.llm.model}（Key 来源 ${report.env.llm.keySource}，${report.env.llm.keyMask}）` : '未启用'}`)
  L.push('```')
  L.push('')
  L.push('## 复现')
  L.push('')
  L.push('```bash')
  L.push(`node bench/run.js ${report.run.argsRaw || ''}`.trim())
  L.push('```')
  L.push('')
  L.push('> 本报告由 `bench/run.js` 生成；跳过项的原因写在套件明细里，跳过不等于通过。')
  return L.join('\n')
}

function loadBaseline(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function saveBaseline(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(snapshot(report), null, 2) + '\n', 'utf8')
}

function writeReports(dir, report) {
  fs.mkdirSync(dir, { recursive: true })
  const jsonFile = path.join(dir, 'bench-report.json')
  const mdFile = path.join(dir, 'bench-report.md')
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
  fs.writeFileSync(mdFile, toMarkdown(report) + '\n', 'utf8')
  return { jsonFile, mdFile }
}

module.exports = { HARNESS, compare, loadBaseline, saveBaseline, snapshot, summarize, toMarkdown, writeReports }

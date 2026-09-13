#!/usr/bin/env node
/**
 * bench/run.js —— 统一评测入口（M0）。
 *
 * 它做的事情只有三件，但把"讲故事"变成"拿数字说话"：
 *   1. 在**隔离的数据目录**里拉起后端（可选再拉起 Python 参考实现做金标准比对）；
 *   2. 把已有探针与 Electron 冒烟按统一契约跑一遍，收日志、解析通过/失败/跳过；
 *   3. 采一份平台量化指标（冷启动/接口时延/包体/产物），输出 JSON + Markdown 报告，
 *      并与基线比对给出回归结论。
 *
 * 用法：
 *   node bench/run.js                     # 全量（本机有界面时含 GUI 冒烟）
 *   node bench/run.js --no-gui            # 只跑探针 + 平台指标（CI 默认）
 *   node bench/run.js --only probe-tables,platform
 *   node bench/run.js --with-reference    # 额外跑金标准比对（Rust vs Python 参考实现）
 *   node bench/run.js --with-llm          # 额外跑需要真实模型的套件（要配好 LLM 环境变量）
 *   node bench/run.js --update-baseline   # 全绿时把当前数字固化为基线
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  fileSize,
  fmtMs,
  freePort,
  gitInfo,
  hostPlatform,
  parseProbeCounts,
  parseSmokeErrors,
  rmrf,
  run,
  sha256File,
  sleep,
  waitForPort,
} = require('./lib/util')
const { copyGoldenDb, describeBinary, resolveBackendBin, resolvePython, startBackend, startProcess, startReference } = require('./lib/backends')
const { describeLlm, llmEnv, resolveLlm } = require('./lib/llm')
const { collectPlatformMetrics } = require('./lib/platform')
const { HARNESS, compare, loadBaseline, saveBaseline, summarize, toMarkdown, writeReports } = require('./lib/report')
const { probes, smokes, EXE } = require('./suites')

const REPO = path.resolve(__dirname, '..')
const isWin = process.platform === 'win32'

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const argOf = (name, def = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const listOf = (name) =>
  argOf(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const opts = {
  noGui: hasFlag('--no-gui') || (!!process.env.CI && !hasFlag('--with-gui')),
  withGui: hasFlag('--with-gui'),
  withLlm: hasFlag('--with-llm'),
  withReference: hasFlag('--with-reference'),
  withMcp: hasFlag('--with-mcp'),
  only: listOf('--only'),
  skip: listOf('--skip'),
  updateBaseline: hasFlag('--update-baseline'),
  strict: hasFlag('--strict'),
  keepData: hasFlag('--keep-data'),
  quiet: hasFlag('--quiet'),
  listOnly: hasFlag('--list'),
  reportDir: path.resolve(REPO, argOf('--report-dir', 'bench/report')),
  dataDir: argOf('--data-dir', ''),
  goldenDb: argOf('--golden-db', 'E:/IUC/rwp-golden/platform.db'),
  llmModel: argOf('--llm-model', ''),
  timeoutScale: Number(argOf('--timeout-scale', '1')) || 1,
  argsRaw: argv.join(' '),
}

const say = (m) => !opts.quiet && console.log(m)
const STATUS_ICON = { pass: '✅', fail: '❌', error: '💥', skipped: '⏭️' }

/** 解析套件命令里的占位符 */
function resolveTokens(value, ctx) {
  return String(value).replace(/\{(\w+)\}/g, (m, key) => (key in ctx ? ctx[key] : m))
}

function electronBin() {
  const base = path.join(REPO, 'desktop', 'node_modules', 'electron', 'dist')
  if (isWin) return path.join(base, 'electron.exe')
  if (process.platform === 'darwin') return path.join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return path.join(base, 'electron')
}

function versionOf(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8' })
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0]
    return text || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const startedAt = new Date()
  const startedMs = Date.now()
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}`

  fs.mkdirSync(opts.reportDir, { recursive: true })
  // 注意：fs.mkdirSync(..., {recursive:true}) 在目录已存在时返回 undefined，不能拿它的返回值当路径
  const logsDir = path.join(opts.reportDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const tmpDir = opts.dataDir || path.join(os.tmpdir(), `rwp-bench-${process.pid}`)
  rmrf(tmpDir)
  fs.mkdirSync(tmpDir, { recursive: true })

  const git = gitInfo(REPO)
  const backend = resolveBackendBin(REPO)
  if (!backend) {
    console.error('找不到后端二进制：请先构建（desktop: npm run build:backend，或 backend: cargo build --release）')
    process.exit(2)
  }
  const webDist = fs.existsSync(path.join(REPO, 'desktop', 'resources', 'web', 'index.html'))
    ? path.join(REPO, 'desktop', 'resources', 'web')
    : path.join(REPO, 'web', 'dist')
  const samplesDir = path.join(REPO, 'data', 'samples')
  const python = resolvePython(REPO, { needHttpx: false })
  const pythonHttpx = resolvePython(REPO, { needHttpx: true })
  const electron = electronBin()

  say(`\n=== rwp-bench v${HARNESS.version} · ${git.short}${git.dirty ? '(dirty)' : ''} · ${process.platform}/${process.arch} ===`)
  say(`后端：${backend.bin}（${backend.kind}，${((fileSize(backend.bin) || 0) / 1048576).toFixed(1)} MB，sha256 ${String(sha256File(backend.bin)).slice(0, 12)}…）`)
  say(`前端产物：${webDist}`)
  say(`Python：${python ? python.bin : '未找到'}${pythonHttpx ? '' : '（无 httpx：金标准比对将跳过）'}`)

  // ---- 可用性判定（不满足就跳过，并写明原因） ----
  // 真实模型：--with-llm 时解析 Key（环境变量 → 桌面 KEY.txt），并注入后端
  const llm = opts.withLlm ? resolveLlm(REPO, { model: opts.llmModel }) : null
  const llmExtraEnv = llm && llm.ready ? llmEnv(llm) : {}
  if (opts.withLlm) {
    say(`真实模型：${llm.ready ? `${llm.baseUrl} · ${llm.model} · Key 来源 ${llm.keySource}（${llm.mask}）` : '未找到 API Key'}`)
  }

  const availability = {}
  availability.gui = opts.noGui
    ? { ok: false, reason: process.env.CI ? 'CI 环境（如需开启：--with-gui）' : '已指定 --no-gui' }
    : { ok: fs.existsSync(electron), reason: fs.existsSync(electron) ? '' : `未找到 Electron：${electron}` }
  availability.image = { ok: fs.existsSync(path.join(REPO, 'desktop', 'resources', 'samples', 'finance_table_demo.png')), reason: '缺少测试图片' }
  availability.llm = !opts.withLlm
    ? { ok: false, reason: '未开启 --with-llm（需要真实模型配额）' }
    : llm.ready
      ? { ok: true, reason: '' }
      : { ok: false, reason: `未找到 API Key（RWP_LLM_API_KEY 或 ${llm.tried[0]}）` }
  availability.mcp = !opts.withMcp
    ? { ok: false, reason: '未开启 --with-mcp（需要本地 mock MCP 服务）' }
    : fs.existsSync(path.join(REPO, 'server', 'tests', 'mock_mcp_server.py')) && pythonHttpx
      ? { ok: true, reason: '' }
      : { ok: false, reason: '缺少 server/tests/mock_mcp_server.py 或带 httpx 的 Python' }
  availability.reference = opts.withReference
    ? { ok: true, reason: '' }
    : { ok: false, reason: '未开启 --with-reference（需要 Python 参考实现 + 金标准库）' }

  // ---- 平台指标（在干净库上先测，保证可比性） ----
  let platform = { metrics: {}, checks: [] }
  const mainPort = await freePort()
  let mainBackend = null
  let referenceHandle = null
  let parityBackend = null
  let mcpHandle = null

  try {
    say(`\n[1/3] 启动隔离后端（端口 ${mainPort}，数据目录 ${tmpDir}）…`)
    mainBackend = await startBackend({
      bin: backend.bin,
      port: mainPort,
      dataDir: path.join(tmpDir, 'rust-main'),
      webDist,
      samplesDir,
      env: llmExtraEnv,
      logFile: path.join(logsDir, 'backend-main.log'),
    })
    if (mainBackend.readyMs === null) {
      console.error('后端未能在 30s 内就绪，评测中止。日志：' + mainBackend.logFile)
      await mainBackend.stop()
      process.exit(2)
    }
    say(`      就绪 ${fmtMs(mainBackend.readyMs)}`)

    const url = `http://127.0.0.1:${mainPort}/`

    // ---- 参照环境（可选） ----
    let parityCtx = {}
    if (opts.withReference) {
      const goldenExists = fs.existsSync(opts.goldenDb)
      if (!goldenExists) {
        availability.reference = { ok: false, reason: `金标准库不存在：${opts.goldenDb}` }
      } else if (!pythonHttpx) {
        availability.reference = { ok: false, reason: '找不到带 httpx 的 Python（server/.venv）' }
      } else {
        say('[1b] 启动 Python 参考实现 + Rust 参照片本（同一份金标准库的两份副本）…')
        const pyDir = path.join(tmpDir, 'py-ref')
        const parityDir = path.join(tmpDir, 'rust-parity')
        copyGoldenDb(opts.goldenDb, pyDir)
        copyGoldenDb(opts.goldenDb, parityDir)
        const pyPort = await freePort()
        const parityPort = await freePort()
        referenceHandle = await startReference({
          repo: REPO,
          port: pyPort,
          dataDir: pyDir,
          logFile: path.join(logsDir, 'reference-python.log'),
          pythonBin: pythonHttpx.bin,
          extraEnv: llmExtraEnv,
        })
        parityBackend = await startBackend({
          bin: backend.bin,
          port: parityPort,
          dataDir: parityDir,
          webDist,
          samplesDir,
          env: llmExtraEnv,
          logFile: path.join(logsDir, 'backend-parity.log'),
        })
        if (referenceHandle.readyMs === null || parityBackend.readyMs === null) {
          availability.reference = {
            ok: false,
            reason: `参照后端未就绪（python=${fmtMs(referenceHandle.readyMs)} rust=${fmtMs(parityBackend.readyMs)}）`,
          }
        } else {
          parityCtx = { parityPort, parityDataDir: parityDir, pyPort, pyDataDir: pyDir, goldenDb: opts.goldenDb }
          say(`      Python 参考 ${fmtMs(referenceHandle.readyMs)} · Rust 参照片本 ${fmtMs(parityBackend.readyMs)}`)
        }
      }
    }

    say('\n[2/3] 采集平台量化指标…')
    platform = await collectPlatformMetrics({ repo: REPO, bin: backend.bin, mainPort, dir: path.join(tmpDir, 'platform'), quiet: opts.quiet })

    // ---- 组装套件执行上下文 ----
    // mock MCP（可选）：给 p4-tools 这类"工具装配"套件用（该探针自己会起 mock LLM）
    let mcpUrl = ''
    if (availability.mcp.ok) {
      // probe-p4 里的 MCP 用例写死了 127.0.0.1:8765 → 默认就起在 8765，被占用再退到空闲端口
      const preferred = Number(process.env.RWP_BENCH_MCP_PORT || 8765)
      let mcpPort = preferred
      mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`
      mcpHandle = await startProcess({
        bin: pythonHttpx.bin,
        args: [path.join(REPO, 'server', 'tests', 'mock_mcp_server.py'), '--port', String(mcpPort)],
        cwd: path.join(REPO, 'server'),
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        logFile: path.join(logsDir, 'mock-mcp.log'),
      })
      let up = await waitForPort(mcpPort, 8000)
      if (!up) {
        await mcpHandle.stop()
        mcpPort = await freePort()
        mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`
        mcpHandle = await startProcess({
          bin: pythonHttpx.bin,
          args: [path.join(REPO, 'server', 'tests', 'mock_mcp_server.py'), '--port', String(mcpPort)],
          cwd: path.join(REPO, 'server'),
          env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          logFile: path.join(logsDir, 'mock-mcp.log'),
        })
        up = await waitForPort(mcpPort, 8000)
      }
      say(`      mock MCP：${mcpUrl}（${up ? '已就绪' : '未就绪'}）`)
      if (!up) availability.mcp = { ok: false, reason: 'mock MCP 未能在 8s 内就绪' }
    }

    const ctx = {
      repo: REPO,
      port: String(mainPort),
      dataDir: path.join(tmpDir, 'rust-main'),
      webDist,
      url,
      exe: backend.bin,
      python: python ? python.bin : 'python',
      electron,
      mcpUrl,
      altPort: String(await freePort()),
      ...parityCtx,
    }

    const all = [...probes, ...smokes]
    const selected = all.filter((s) => {
      if (opts.only.length && !opts.only.includes(s.id)) return false
      if (opts.skip.includes(s.id)) return false
      return true
    })

    if (opts.listOnly) {
      console.log('\n可用套件：')
      for (const s of selected) {
        const miss = (s.requires || []).filter((r) => !(availability[r] && availability[r].ok))
        console.log(`  ${miss.length ? '⏭️ ' : '▶️ '} ${s.id.padEnd(24)} ${s.title}${miss.length ? `  [跳过：${availability[miss[0]].reason}]` : ''}`)
      }
      await cleanup()
      return 0
    }

    say(`\n[3/3] 执行套件（${selected.length} 个）…\n`)
    const results = []
    for (const suite of selected) {
      const missing = (suite.requires || []).filter((r) => !(availability[r] && availability[r].ok))
      if (missing.length) {
        results.push({
          id: suite.id,
          title: suite.title,
          kind: suite.kind,
          tier: suite.tier || 'gate',
          status: 'skipped',
          reason: availability[missing[0]].reason,
          durationMs: 0,
          checksPassed: 0,
          checksFailed: 0,
        })
        say(`  ⏭️  ${suite.id.padEnd(24)} 跳过：${availability[missing[0]].reason}`)
        continue
      }

      const binKey = suite.bin
      const bin = binKey === 'python' ? (python ? python.bin : 'python') : binKey === 'python-httpx' ? pythonHttpx.bin : binKey === 'electron' ? electron : binKey
      // 少数套件需要特殊的后端配置（例如把上下文窗口压小以真正触发压缩）→ 为它单独起一个后端
      let suitePort = mainPort
      let dedicated = null
      if (suite.backendEnv) {
        suitePort = await freePort()
        dedicated = await startBackend({
          bin: backend.bin,
          port: suitePort,
          dataDir: path.join(tmpDir, `backend-${suite.id}`),
          webDist,
          samplesDir,
          env: { ...llmExtraEnv, ...suite.backendEnv },
          logFile: path.join(logsDir, `backend-${suite.id}.log`),
        })
        if (dedicated.readyMs === null) {
          results.push({
            id: suite.id,
            title: suite.title,
            kind: suite.kind,
            tier: suite.tier || 'gate',
            status: 'error',
            reason: '专用后端未能就绪',
            durationMs: 0,
            checksPassed: 0,
            checksFailed: 0,
          })
          await dedicated.stop()
          continue
        }
      }
      const suiteCtx = { ...ctx, port: String(suitePort), url: `http://127.0.0.1:${suitePort}/` }
      const args = (suite.args || []).map((a) => resolveTokens(a, suiteCtx))
      const env = Object.fromEntries(Object.entries(suite.env || {}).map(([k, v]) => [k, resolveTokens(v, suiteCtx)]))
      // Python 在 Windows 上默认按控制台代码页输出（GBK），日志会变乱码、断言也解析不出来
      if (binKey.startsWith('python')) {
        env.PYTHONIOENCODING = 'utf-8'
        env.PYTHONUTF8 = '1'
      }
      const logFile = path.join(logsDir, `${suite.id}.log`)
      const timeoutMs = Math.round((suite.timeoutMs || 180000) * opts.timeoutScale)

      const startedSuite = Date.now()
      const res = await run({ bin, args, cwd: REPO, env, timeoutMs, logFile, quiet: true })
      const parsed = parseSuiteResult(suite, res)
      if (dedicated) await dedicated.stop()
      results.push({
        id: suite.id,
        title: suite.title,
        kind: suite.kind,
        tier: suite.tier || 'gate',
        status: parsed.status,
        reason: parsed.reason,
        durationMs: Date.now() - startedSuite,
        checksPassed: parsed.checksPassed,
        checksFailed: parsed.checksFailed,
        metrics: parsed.metrics,
        exitCode: res.code,
        timedOut: res.timedOut,
        cmd: `${path.basename(bin)} ${args.join(' ')}`,
        log: path.relative(REPO, logFile),
        stderrTail: parsed.status === 'pass' ? '' : lastLines(`${res.stdout}\n${res.stderr}`, 12),
      })
      const r = results[results.length - 1]
      const checks = r.checksPassed || r.checksFailed ? `${r.checksPassed}✓${r.checksFailed ? `/${r.checksFailed}✗` : ''}` : ''
      say(`  ${STATUS_ICON[r.status]} ${suite.id.padEnd(24)} ${checks.padEnd(9)} ${fmtMs(r.durationMs)}${r.reason ? '  ' + r.reason : ''}`)
    }

    // ---- 报告 ----
    const finishedAt = new Date()
    const env = {
      ...hostPlatform(),
      python: python ? `${python.bin} (${versionOf(python.bin, ['--version'] ) || '?'})` : null,
      pythonHttpx: pythonHttpx ? pythonHttpx.bin : null,
      rustc: versionOf('rustc', ['--version']),
      cargo: versionOf('cargo', ['--version']),
      appVersion: JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf8')).version,
      backendBinary: { kind: backend.kind, ...describeBinary(backend.bin) },
      webDist: path.relative(REPO, webDist),
      llm: llm && opts.withLlm ? describeLlm(llm) : null,
    }

    const report = {
      harness: HARNESS,
      run: {
        id: runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        mode: { gui: !opts.noGui, llm: opts.withLlm, reference: !!(parityCtx.pyPort && availability.reference.ok) },
        argsRaw: opts.argsRaw,
      },
      git,
      env,
      suites: results,
      platform,
      availability,
    }
    report.summary = summarize(results, platform)
    report.baseline = compare(report, loadBaseline(path.join(REPO, 'bench', 'baseline.json')))

    const { jsonFile, mdFile } = writeReports(opts.reportDir, report)

    // ---- 控制台小结 ----
    const s = report.summary
    say('\n──────────────── 结果 ────────────────')
    say(`套件：${s.suites.total} 个 → 通过 ${s.suites.pass} / 失败 ${s.suites.fail} / 错误 ${s.suites.error} / 跳过 ${s.suites.skipped}`)
    say(`断言：通过 ${s.checks.passed} / 失败 ${s.checks.failed}`)
    say(`整轮耗时：${fmtMs(report.run.durationMs)}`)
    if (report.baseline.available) {
      say(`基线比对：${report.baseline.regressions.length ? `❌ ${report.baseline.regressions.length} 项回归` : '✅ 无回归'}${report.baseline.warnings.length ? `，⚠ ${report.baseline.warnings.length} 项变差提醒` : ''}`)
      for (const r of report.baseline.regressions) say(`   ❌ ${r}`)
      for (const w of report.baseline.warnings) say(`   ⚠ ${w}`)
    }
    say(`报告：${path.relative(REPO, mdFile)} / ${path.relative(REPO, jsonFile)}`)

    if (opts.updateBaseline) {
      if (s.status === 'pass') {
        saveBaseline(path.join(REPO, 'bench', 'baseline.json'), report)
        say('已更新基线：bench/baseline.json')
      } else {
        say('本轮未全绿，拒绝更新基线（基线只记录"公认良好"的数字）')
      }
    }

    await cleanup()
    const failed = s.status !== 'pass'
    const regressed = opts.strict && report.baseline.available && report.baseline.regressions.length > 0
    return failed || regressed ? 1 : 0
  } catch (err) {
    console.error('评测异常：', err && err.stack ? err.stack : err)
    await cleanup()
    return 2
  }

  async function cleanup() {
    if (mainBackend) await mainBackend.stop()
    if (parityBackend) await parityBackend.stop()
    if (referenceHandle) await referenceHandle.stop()
    if (mcpHandle) await mcpHandle.stop()
    if (!opts.keepData) {
      await sleep(150)
      rmrf(tmpDir)
    } else {
      say(`临时数据保留在：${tmpDir}`)
    }
  }
}

function lastLines(text, n) {
  return String(text).trim().split(/\r?\n/).slice(-n).join('\n')
}

/** 从输出里抽可量化指标（金标准比对项数就是最有说服力的一个） */
function extractMetrics(text) {
  const m = {}
  const cmp = text.match(/比对项\s*(\d+)\s*个[，,]\s*差异\s*(\d+)\s*处/)
  if (cmp) {
    m.comparisonPoints = Number(cmp[1])
    m.diffs = Number(cmp[2])
  }
  const toler = text.match(/财务字段在\s*(\d+)%\s*容差内一致/)
  if (toler) m.financeTolerancePct = Number(toler[1])
  const news = text.match(/新闻条数：Rust=(\d+)\s+Python=(\d+)/)
  if (news) m.newsRust = Number(news[1])
  // 对话链路的量化痕迹：压缩次数、缓存命中率、LLM 调用轮数
  const compact = text.match(/"compact_count":\s*(\d+)/)
  if (compact) m.compactCount = Number(compact[1])
  const cache = text.match(/"cache_hit_rate":\s*([\d.]+)/)
  if (cache) m.cacheHitRate = Number(cache[1])
  const calls = text.match(/"llm_calls":\s*(\d+)/)
  if (calls) m.llmCalls = Number(calls[1])
  const steps = text.match(/steps=(\d+)/)
  if (steps) m.agentSteps = Number(steps[1])
  return m
}

/** 把一次进程执行解析成套件结论：退出码为准，输出用于取断言数并交叉校验 */
function parseSuiteResult(suite, res) {
  const text = `${res.stdout}\n${res.stderr}`
  const counts = suite.parse === 'probe' ? parseProbeCounts(text) : null
  const errors = suite.parse === 'smoke' ? parseSmokeErrors(text) : null
  const stepTimeout = /STEP_TIMEOUT/.test(text)
  const metrics = extractMetrics(text)

  let status = 'pass'
  let reason = ''
  if (res.timedOut) {
    status = 'fail'
    reason = `超时（>${Math.round((suite.timeoutMs || 0) / 1000)}s）`
  } else if (res.code !== 0) {
    status = 'fail'
    reason = `退出码 ${res.code}`
  } else if (counts && counts.failed > 0) {
    status = 'fail'
    reason = `探针自报 ${counts.failed} 项失败`
  } else if (errors && errors.length) {
    status = 'fail'
    reason = `界面报错 ${errors.length} 条`
  } else if (stepTimeout) {
    status = 'fail'
    reason = '脚本内有步骤超时（STEP_TIMEOUT）'
  } else if (metrics.diffs > 0) {
    status = 'fail'
    reason = `金标准比对存在 ${metrics.diffs} 处差异`
  } else if (suite.rejectOutput && new RegExp(suite.rejectOutput).test(text)) {
    // 有些套件"跑完不报错"并不代表测到了东西（例：压缩根本没触发）→ 用反例断言兜住
    status = 'fail'
    reason = suite.rejectReason || `命中了不应该出现的输出：${suite.rejectOutput}`
  } else if (suite.expectOutput && !new RegExp(suite.expectOutput).test(text)) {
    status = 'fail'
    reason = suite.expectReason || `输出中缺少期望内容：${suite.expectOutput}`
  }

  // 冒烟没有细粒度断言，整条链路算 1 条：让总数能反映"验证面"而不只是探针
  const isSmoke = suite.kind === 'smoke'
  return {
    status,
    reason,
    metrics,
    checksPassed: counts ? counts.passed : isSmoke && status === 'pass' ? 1 : 0,
    checksFailed: counts ? counts.failed : isSmoke && status !== 'pass' ? 1 : 0,
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err)
    process.exit(2)
  })

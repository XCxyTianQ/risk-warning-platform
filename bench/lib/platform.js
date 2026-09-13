/**
 * bench/lib/platform.js —— 平台级量化指标（不依赖 LLM，任何机器都能跑）。
 *
 * 这里出的数字就是汇报里能直接引用的那部分：
 *   冷启动、只读接口时延分布、前端包体、产物完整性、样例数据是否灌入。
 * 门槛写得很保守（本机 p95 只有 ~20ms，门限定在 150ms），目的是**发现退化**而不是卡开发。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const { fileSize, freePort, fmtMs, httpGet, listFiles, rmrf, round, sha256File, sleep } = require('./util')
const { copyGoldenDb, startBackend } = require('./backends')

const READ_ENDPOINTS = ['/api/health', '/api/enterprises', '/api/tables', '/api/alerts', '/api/summary/dashboard', '/api/skills', '/api/presets']
const SAMPLES = 25

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

async function coldStart({ bin, dir, runs = 3 }) {
  const samples = []
  const ports = []
  for (let i = 0; i < runs; i++) {
    const port = await freePort()
    ports.push(port)
    const dataDir = path.join(dir, `cold-${i}`)
    rmrf(dataDir)
    fs.mkdirSync(dataDir, { recursive: true })
    // 用一份已有样例企业的库，避免把"首次建库+灌样例"算进冷启动
    const seedDb = path.join(dir, 'cold-seed', 'platform.db')
    if (fs.existsSync(seedDb)) fs.copyFileSync(seedDb, path.join(dataDir, 'platform.db'))
    const started = Date.now()
    const handle = await startBackend({
      bin,
      port,
      dataDir,
      webDist: path.join(dir, 'no-web'),
      logFile: path.join(dir, `cold-${i}.log`),
      readyTimeoutMs: 20000,
    })
    const ready = handle.readyMs === null ? null : Date.now() - started - (handle.readyMs ? 0 : 0)
    samples.push(handle.readyMs)
    await handle.stop()
    if (i === 0) {
      // 第一轮把带样例的库留作后续冷启动的种子
      fs.mkdirSync(path.join(dir, 'cold-seed'), { recursive: true })
      fs.copyFileSync(path.join(dataDir, 'platform.db'), seedDb)
    }
    void ready
  }
  const valid = samples.filter((x) => typeof x === 'number')
  const sorted = [...valid].sort((a, b) => a - b)
  return { samples, medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }
}

async function apiLatency(port) {
  const out = {}
  for (const p of READ_ENDPOINTS) {
    const ms = []
    let lastStatus = 0
    for (let i = 0; i < SAMPLES; i++) {
      const r = await httpGet(port, p, 10000)
      lastStatus = r.status
      if (r.status === 200) ms.push(r.ms)
    }
    const sorted = [...ms].sort((a, b) => a - b)
    out[p] = {
      status: lastStatus,
      n: ms.length,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      max: round(sorted[sorted.length - 1]),
    }
  }
  return out
}

function bundleMetrics(assetsDir) {
  const files = [...listFiles(assetsDir, ['.js']), ...listFiles(assetsDir, ['.css'])].sort()
  const items = files.map((f) => {
    const raw = fs.readFileSync(f)
    return {
      file: path.basename(f),
      rawBytes: raw.length,
      gzipBytes: zlib.gzipSync(raw).length,
    }
  })
  const js = items.filter((i) => i.file.endsWith('.js'))
  return {
    items,
    jsRawBytes: js.reduce((s, i) => s + i.rawBytes, 0),
    jsGzipBytes: js.reduce((s, i) => s + i.gzipBytes, 0),
    jsFiles: js.length,
  }
}

function artifactChecks(repo) {
  const exe = process.platform === 'win32' ? 'risk-warning-backend.exe' : 'risk-warning-backend'
  const docsDir = path.join(repo, 'docs')
  const releaseNotes = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir).filter((f) => /^release-v.+\.md$/.test(f))
    : []
  const required = [
    ['前端产物 index.html', path.join(repo, 'desktop', 'resources', 'web', 'index.html')],
    ['后端二进制', path.join(repo, 'desktop', 'resources', 'backend', exe)],
    ['样例数据 dataset.json', path.join(repo, 'data', 'samples', 'dataset.json')],
    ['评测框架 bench/run.js', path.join(repo, 'bench', 'run.js')],
  ]
  const items = required.map(([name, file]) => ({ name, file, sizeBytes: fileSize(file), ok: (fileSize(file) || 0) > 0 }))
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'desktop', 'package.json'), 'utf8'))
  const backendBin = path.join(repo, 'desktop', 'resources', 'backend', exe)
  return {
    items,
    releaseNotes: releaseNotes.length,
    appVersion: pkg.version,
    backend: { sizeBytes: fileSize(backendBin), sha256: sha256File(backendBin) },
  }
}

function kb(bytes) {
  if (!bytes && bytes !== 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(2)} MB`
}

/**
 * 跑完整套平台指标。
 * @param {{repo:string, bin:string, mainPort:number, dir:string, quiet?:boolean}} opts
 */
async function collectPlatformMetrics({ repo, bin, mainPort, dir, quiet }) {
  const log = (m) => !quiet && console.log(m)
  const metrics = {}
  const checks = []

  // 1) 产物完整性 + 版本
  const artifacts = artifactChecks(repo)
  metrics.artifacts = artifacts
  for (const it of artifacts.items) {
    checks.push({ name: `产物存在：${it.name}`, ok: it.ok, severity: 'gate', detail: kb(it.sizeBytes) })
  }

  // 2) 冷启动
  log('  [platform] 冷启动测量…')
  const cold = await coldStart({ bin, dir: path.join(dir, 'cold'), runs: 3 })
  metrics.coldStart = cold
  checks.push({
    name: '后端冷启动中位数 ≤ 3000ms',
    ok: cold.medianMs !== null && cold.medianMs <= 3000,
    severity: 'gate',
    detail: cold.samples.map((s) => fmtMs(s)).join(' / '),
  })

  // 3) 只读接口时延
  log('  [platform] 接口时延采样…')
  const lat = await apiLatency(mainPort)
  metrics.apiLatency = lat
  const worst = Object.entries(lat).sort((a, b) => (b[1].p95 || 0) - (a[1].p95 || 0))[0]
  checks.push({
    name: '只读接口 p95 ≤ 150ms',
    ok: !!worst && worst[1].p95 !== null && worst[1].p95 <= 150,
    severity: 'gate',
    detail: worst ? `最慢 ${worst[0]} p95=${worst[1].p95}ms` : '无数据',
  })

  // 4) 前端包体
  const assetsDir = path.join(repo, 'web', 'dist', 'assets')
  if (fs.existsSync(assetsDir)) {
    const bundles = bundleMetrics(assetsDir)
    metrics.bundles = bundles
    checks.push({
      name: '前端 JS 原始体积 ≤ 2.5MB',
      ok: bundles.jsRawBytes <= 2.5 * 1024 * 1024,
      severity: 'gate',
      detail: `${(bundles.jsRawBytes / 1024).toFixed(0)}KB raw / ${(bundles.jsGzipBytes / 1024).toFixed(0)}KB gzip（${bundles.jsFiles} 个 chunk）`,
    })
    // 拆包是 v1 目标，不是当前门禁：失败只提示，不把整块看板判红
    checks.push({
      name: '前端已拆包（chunk 数 ≥ 2）',
      ok: bundles.jsFiles >= 2,
      severity: 'info',
      detail: `${bundles.jsFiles} 个 JS chunk（单包=未拆包，v1 目标 ≥2）`,
    })
  } else {
    checks.push({ name: '前端产物存在（web/dist/assets）', ok: false, severity: 'gate', detail: '未构建：先跑 npm run build' })
  }

  // 5) 样例数据是否灌入（通过接口确认，不直接读库）
  const ents = await httpGet(mainPort, '/api/enterprises', 10000)
  let count = null
  try {
    const parsed = JSON.parse(ents.body)
    count = parsed.total ?? (parsed.items || []).length
  } catch {}
  metrics.sampleEnterprises = count
  checks.push({ name: '样例企业已灌入（≥5 家）', ok: typeof count === 'number' && count >= 5, severity: 'gate', detail: `enterprises=${count}` })

  return { metrics, checks }
}

module.exports = { collectPlatformMetrics, copyGoldenDb }

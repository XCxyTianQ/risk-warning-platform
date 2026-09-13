/**
 * bench/lib/backends.js —— 评测用的后端生命周期管理。
 *
 * 评测必须跑在**隔离的数据目录**里，绝不能用开发者或队友的真实数据目录：
 *  - 主后端：全新临时目录，首次启动会自动灌入 5 家样例企业（探针依赖它们）；
 *  - 参照后端（可选）：Rust 与 Python 各起一个，喂**同一份金标准库的副本**，
 *    用于逐点比对（Rust vs Python 参考实现）。
 */
const fs = require('node:fs')
const path = require('node:path')

const { fileSize, fmtMs, freePort, killTree, sha256File, sleep, waitForHealth } = require('./util')

const EXE = process.platform === 'win32' ? 'risk-warning-backend.exe' : 'risk-warning-backend'

/** 后端二进制优先级：发布产物（resources）→ release → debug */
function resolveBackendBin(repo) {
  const desktop = path.join(repo, 'desktop')
  const candidates = [
    { bin: path.join(desktop, 'resources', 'backend', EXE), kind: 'packaged' },
    { bin: path.join(repo, 'backend', 'target', 'release', EXE), kind: 'release' },
    { bin: path.join(repo, 'backend', 'target', 'debug', EXE), kind: 'debug' },
  ]
  return candidates.find((c) => fs.existsSync(c.bin)) || null
}

/**
 * 启动一个 Rust 后端并等它就绪。
 * @returns {Promise<{port:number, readyMs:number|null, pid:number, stop:Function, logFile:string, bin:string}>}
 */
async function startBackend({ bin, port, dataDir, webDist, samplesDir, logFile, env = {}, readyTimeoutMs = 30000 }) {
  fs.mkdirSync(dataDir, { recursive: true })
  const { spawn } = require('node:child_process')
  const out = fs.createWriteStream(logFile, { flags: 'w' })
  const child = spawn(bin, ['--port', String(port), '--data-dir', dataDir, '--web-dist', webDist], {
    cwd: path.dirname(bin),
    env: {
      ...process.env,
      ...(samplesDir ? { RWP_SAMPLES_DIR: samplesDir } : {}),
      // 评测里默认关掉启动预热：它是真实 LLM 调用，既慢又花钱，且与断言无关
      RWP_PREHEAT_ON_STARTUP: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)

  const readyMs = await waitForHealth(port, readyTimeoutMs)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    killTree(child.pid)
    await sleep(120)
    out.end()
  }
  return { port, readyMs, pid: child.pid, stop, logFile, bin, dataDir }
}

/** 找可用的 Python：需要 httpx 的探针必须用带 httpx 的解释器（仓库里是 server/.venv） */
function resolvePython(repo, { needHttpx = false } = {}) {
  const { spawnSync } = require('node:child_process')
  const candidates = [
    { bin: path.join(repo, 'server', '.venv', 'Scripts', 'python.exe'), kind: 'server-venv' },
    { bin: path.join(repo, 'server', '.venv', 'bin', 'python'), kind: 'server-venv' },
    { bin: process.platform === 'win32' ? 'python' : 'python3', kind: 'system' },
    { bin: 'python', kind: 'system' },
  ].filter((c) => c.bin.includes(path.sep) === false || fs.existsSync(c.bin))

  for (const c of candidates) {
    const probe = spawnSync(c.bin, ['-c', needHttpx ? 'import httpx' : 'import json,sqlite3,urllib.request'], {
      encoding: 'utf8',
    })
    if (probe.status === 0) return { ...c, hasHttpx: needHttpx ? true : probe.status === 0 }
  }
  return null
}

/** 启动 Python 参考实现（uvicorn），用于金标准逐点比对 */
async function startReference({ repo, port, dataDir, logFile, pythonBin, extraEnv = {}, readyTimeoutMs = 60000 }) {
  const { spawn } = require('node:child_process')
  fs.mkdirSync(dataDir, { recursive: true })
  const out = fs.createWriteStream(logFile, { flags: 'w' })
  const child = spawn(
    pythonBin,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    {
      cwd: path.join(repo, 'server'),
      env: {
        ...process.env,
        RWP_DATA_DIR: dataDir,
        RWP_SAMPLES_DIR: path.join(repo, 'data', 'samples'),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  const readyMs = await waitForHealth(port, readyTimeoutMs)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    killTree(child.pid)
    await sleep(120)
    out.end()
  }
  return { port, readyMs, pid: child.pid, stop, logFile, dataDir }
}

/** 复制一份金标准库到目标目录（两份副本分别给 Rust 与 Python，避免写冲突） */
function copyGoldenDb(goldenDb, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const dst = path.join(targetDir, 'platform.db')
  fs.copyFileSync(goldenDb, dst)
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.copyFileSync(goldenDb + suffix, dst + suffix)
    } catch {}
  }
  return dst
}

/** 启动一个长期运行的辅助进程（例如 mock MCP 服务），返回句柄与 stop() */
async function startProcess({ bin, args = [], cwd, env = {}, logFile }) {
  const { spawn } = require('node:child_process')
  const out = fs.createWriteStream(logFile, { flags: 'w' })
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  let stopped = false
  return {
    pid: child.pid,
    logFile,
    async stop() {
      if (stopped) return
      stopped = true
      killTree(child.pid)
      await sleep(120)
      out.end()
    },
  }
}

function describeBinary(bin) {
  return { path: bin, sizeBytes: fileSize(bin), sha256: sha256File(bin) }
}

module.exports = {
  copyGoldenDb,
  describeBinary,
  resolveBackendBin,
  resolvePython,
  startBackend,
  startProcess,
  startReference,
  fmtMs,
}

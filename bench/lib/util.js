/**
 * bench/lib/util.js —— 评测框架的基础工具：进程、时间、HTTP、文件指纹。
 *
 * 设计原则：
 *  - 不引入任何第三方依赖（只用 Node 标准库），这样 CI 与队友机器上都能直接跑；
 *  - 所有外部进程都必须能被超时杀掉（Windows 用 taskkill /T，POSIX 用进程组），
 *    否则一次卡死就会把整个评测挂住——这是踩过的坑；
 *  - 只做机制，不做判定：判定规则集中在 report.js，便于以后调整门槛。
 */
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const isWin = process.platform === 'win32'

const nowIso = () => new Date().toISOString()

const fmtMs = (ms) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

const round = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null)

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {}
}

/** 选一个空闲端口：先 listen(0) 拿端口再关掉（存在极小概率被抢占，够用） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/** 杀进程树：Windows 上 Electron/Rust 都可能带子进程 */
function killTree(pid) {
  if (!pid) return
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/**
 * 跑一个外部命令，带超时与日志落盘。
 * @returns {Promise<{code:number|null, timedOut:boolean, durationMs:number, stdout:string, stderr:string, logFile:string}>}
 */
function run({ bin, args = [], cwd, env, timeoutMs = 180000, logFile, quiet = false, onLine }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const out = logFile ? fs.createWriteStream(logFile, { flags: 'w' }) : null
    const write = (chunk, isErr) => {
      const text = String(chunk)
      if (isErr) stderr += text
      else stdout += text
      if (out) out.write(text)
      if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line, isErr)
      if (!quiet) process.stdout.write(isErr ? '' : '')
    }

    let child
    try {
      child = spawn(bin, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      })
    } catch (err) {
      if (out) out.end()
      resolve({
        code: -1,
        timedOut: false,
        durationMs: Date.now() - started,
        stdout,
        stderr: `spawn 失败：${err.message}`,
        logFile,
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      // 兜底：再等 5 秒强制收尾
      setTimeout(() => {
        if (!settled) {
          settled = true
          if (out) out.end()
          resolve({ code: null, timedOut: true, durationMs: Date.now() - started, stdout, stderr, logFile })
        }
      }, 5000)
    }, timeoutMs)

    child.stdout.on('data', (d) => write(d, false))
    child.stderr.on('data', (d) => write(d, true))
    child.on('error', (err) => write(String(err.message), true))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (out) out.end()
      resolve({ code, timedOut, durationMs: Date.now() - started, stdout, stderr, logFile })
    })
  })
}

/** GET 一个本地 HTTP 接口，返回状态、耗时与文本体 */
function httpGet(port, urlPath, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, body }))
    })
    req.on('error', (err) => resolve({ status: 0, ms: Date.now() - started, body: '', error: err.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, ms: Date.now() - started, body: '', error: 'timeout' })
    })
  })
}

/** 等后端就绪，返回就绪耗时（ms）；超时返回 null */
async function waitForHealth(port, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const r = await httpGet(port, '/api/health', 2000)
    if (r.status === 200) return Date.now() - started
    await sleep(120)
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等某个端口开始接受连接（用于 mock 服务就绪判断） */
async function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy()
        resolve(true)
      })
      sock.on('error', () => resolve(false))
      sock.setTimeout(1000, () => {
        sock.destroy()
        resolve(false)
      })
    })
    if (ok) return Date.now() - started
    await sleep(150)
  }
  return null
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

/** 目录里按后缀收集文件（非递归） */
function listFiles(dir, exts = []) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => (exts.length ? exts.some((e) => f.endsWith(e)) : true))
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).isFile())
  } catch {
    return []
  }
}

function gitInfo(repo) {
  const runGit = (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    return r.status === 0 ? String(r.stdout).trim() : ''
  }
  const commit = runGit(['rev-parse', 'HEAD'])
  const status = runGit(['status', '--porcelain'])
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const describe = runGit(['describe', '--tags', '--always'])
  return { commit, short: commit ? commit.slice(0, 7) : '', branch, describe, dirty: !!status, dirtyFiles: status ? status.split('\n').length : 0 }
}

/** 从文本里抠出 marker 之后的第一个完整 JSON（花括号配平，字符串内的括号不计） */
function extractJsonAfter(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) return null
  const start = text.indexOf('{', at + marker.length)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 解析探针结尾的 “=== 结果：N 通过 / M 失败 ===” */
function parseProbeCounts(text) {
  const m = text.match(/结果[：:]\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
  if (!m) return null
  return { passed: Number(m[1]), failed: Number(m[2]) }
}

/** 解析冒烟结尾的 ERRORS: [...] 或 SUMMARY 里的 errors 数组 */
function parseSmokeErrors(text) {
  const m = text.match(/ERRORS:\s*(\[[^\]]*\])/)
  if (m) {
    try {
      return JSON.parse(m[1])
    } catch {
      return null
    }
  }
  const summary = extractJsonAfter(text, 'SUMMARY:')
  if (summary && Array.isArray(summary.errors)) return summary.errors
  return null
}

function hostPlatform() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    node: process.version,
  }
}

module.exports = {
  extractJsonAfter,
  fileSize,
  fmtMs,
  freePort,
  gitInfo,
  hostPlatform,
  httpGet,
  isWin,
  killTree,
  listFiles,
  mkdirp,
  nowIso,
  parseProbeCounts,
  parseSmokeErrors,
  rmrf,
  round,
  run,
  sha256File,
  sleep,
  waitForHealth,
  waitForPort,
}

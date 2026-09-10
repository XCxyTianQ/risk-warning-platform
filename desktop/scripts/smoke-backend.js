/**
 * 冒烟测试：直接拉起后端二进制，校验它能起来、能建库、能响应 /api/health。
 * 用法：node scripts/smoke-backend.js [--exe <path>] [--data-dir <dir>]
 *
 * 与旧的 Python smoke_backend.py 的区别：产物是**单文件二进制**，无需检查
 * `_internal` 目录与解释器版本，只需验证进程能启动并在超时内就绪。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}

const isWin = process.platform === 'win32'
const repo = path.resolve(__dirname, '..', '..')
const exeName = isWin ? 'risk-warning-backend.exe' : 'risk-warning-backend'
const exe = argOf('--exe') || path.join(__dirname, '..', 'resources', 'backend', exeName)
const dataDir = argOf('--data-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'rwp-smoke-'))
const webDist = path.join(__dirname, '..', 'resources', 'web')
const timeoutMs = Number(process.env.RWP_SMOKE_TIMEOUT_MS || 60000)

if (!fs.existsSync(exe)) {
  console.error('[smoke] 未找到后端二进制：', exe)
  process.exit(1)
}
if (!isWin) {
  try {
    fs.chmodSync(exe, 0o755)
  } catch {}
}

console.log('[smoke] exe =', exe)
console.log('[smoke] data-dir =', dataDir)

const child = spawn(exe, ['--port', '0', '--data-dir', dataDir, '--web-dist', webDist], {
  cwd: path.dirname(exe),
  env: { ...process.env, RWP_SAMPLES_DIR: path.join(repo, 'data', 'samples') },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let port = 0
let out = ''
let done = false

const finish = (code, message) => {
  if (done) return
  done = true
  try {
    child.kill('SIGKILL')
  } catch {}
  if (message) console.log(message)
  // 给进程一点时间退出，避免 CI 上留下孤儿进程
  setTimeout(() => process.exit(code), 200)
}

const timer = setTimeout(() => finish(1, `[smoke] 超时（${timeoutMs}ms）未就绪\n${out}`), timeoutMs)

child.stdout.on('data', (d) => {
  const text = String(d)
  out += text
  process.stdout.write('[backend] ' + text)
  const m = text.match(/RWP_PORT=(\d+)/)
  if (m && !port) {
    port = Number(m[1])
    probe()
  }
})
child.stderr.on('data', (d) => {
  out += String(d)
  process.stderr.write('[backend:err] ' + String(d))
})
child.on('exit', (code) => {
  if (!done && !port) {
    clearTimeout(timer)
    finish(1, `[smoke] 后端提前退出（code=${code}）\n${out}`)
  }
})

function probe() {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 10000 }, (res) => {
    let body = ''
    res.on('data', (c) => (body += c))
    res.on('end', () => {
      clearTimeout(timer)
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {}
      const ok = res.statusCode === 200 && parsed.status === 'ok'
      finish(
        ok ? 0 : 1,
        ok
          ? `SMOKE_OK port=${port} runtime=${parsed.runtime || '-'} version=${parsed.version || '-'}`
          : `[smoke] /api/health 异常：HTTP ${res.statusCode} ${body}`,
      )
    })
  })
  req.on('error', (err) => {
    clearTimeout(timer)
    finish(1, `[smoke] 健康检查失败：${err.message}`)
  })
  req.on('timeout', () => {
    req.destroy()
    clearTimeout(timer)
    finish(1, '[smoke] 健康检查超时')
  })
}

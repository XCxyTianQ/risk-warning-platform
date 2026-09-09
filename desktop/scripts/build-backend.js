/**
 * 用 PyInstaller 打包 Python 后端到 desktop/resources/backend/risk-api/
 * 用法：node scripts/build-backend.js
 *
 * 跨平台说明：
 *  - Windows 产出 risk-api.exe，macOS/Linux 产出 risk-api（Mach-O）
 *  - Python 解释器解析顺序：RWP_PYTHON 环境变量 → server/.venv → PATH 上的 python/python3
 *    （CI 无 venv，直接使用 setup-python 提供的解释器）
 *  - macOS 上构建后对主程序做 ad-hoc 签名（Apple Silicon 要求所有可执行文件有签名）
 *
 * 说明：
 *  - 采用 onedir（目录）模式：首启快、不易被杀软误报
 *  - 体积较大（pandas/numpy/akshare），首次构建约 3~8 分钟
 */
const { execSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const repo = path.resolve(__dirname, '..', '..')
const serverDir = path.join(repo, 'server')
const outDir = path.join(__dirname, '..', 'resources', 'backend')
const samplesTarget = path.join(__dirname, '..', 'resources', 'samples')
const exeName = isWin ? 'risk-api.exe' : 'risk-api'

function resolvePython() {
  if (process.env.RWP_PYTHON) return process.env.RWP_PYTHON
  const venv = isWin
    ? path.join(serverDir, '.venv', 'Scripts', 'python.exe')
    : path.join(serverDir, '.venv', 'bin', 'python3')
  if (fs.existsSync(venv)) return venv
  return isWin ? 'python' : 'python3'
}

const py = resolvePython()
console.log('[build-backend] platform:', process.platform, process.arch, '| python:', py)

// 依赖自检：缺 akshare 会导致打包产物无法刷新数据，必须显式失败
try {
  execSync(`"${py}" -c "import akshare, fastapi, uvicorn, sqlalchemy, httpx"`, { stdio: 'ignore' })
} catch {
  console.error('[build-backend] 缺少后端依赖。请先执行：')
  console.error(`  "${py}" -m pip install -r server/requirements.txt`)
  process.exit(1)
}

try {
  execSync(`"${py}" -c "import PyInstaller"`, { stdio: 'ignore' })
} catch {
  console.log('[build-backend] 安装 PyInstaller…')
  execSync(`"${py}" -m pip install pyinstaller`, { stdio: 'inherit' })
}

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const args = [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean',
  '--name', 'risk-api',
  '--distpath', outDir,
  '--workpath', path.join(__dirname, '..', '.pyinstaller'),
  '--specpath', path.join(__dirname, '..', '.pyinstaller'),
  '--hidden-import', 'uvicorn.logging',
  '--hidden-import', 'uvicorn.loops.auto',
  '--hidden-import', 'uvicorn.protocols.http.auto',
  '--hidden-import', 'uvicorn.protocols.websockets.auto',
  '--hidden-import', 'uvicorn.lifespan.on',
  '--hidden-import', 'sqlalchemy.dialects.sqlite',
  '--collect-all', 'akshare',
  '--collect-submodules', 'pandas',
  '--collect-data', 'certifi',
  'desktop_entry.py',
]
console.log('[build-backend] running PyInstaller…')
execSync(`"${py}" ${args.join(' ')}`, { cwd: serverDir, stdio: 'inherit' })

const built = path.join(outDir, 'risk-api', exeName)
if (!fs.existsSync(built)) {
  console.error('[build-backend] 未找到产物：', built)
  process.exit(1)
}
fs.chmodSync(built, 0o755)

// macOS：ad-hoc 签名（Apple Silicon 要求所有 Mach-O 可执行文件都有签名，
// 未签名的嵌套动态库会导致 App 启动即崩溃）
if (isMac) {
  const sign = (file) => spawnSync('codesign', ['--force', '--sign', '-', file], { stdio: 'ignore' })
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      return e.isDirectory() ? walk(p) : [p]
    })
  let signed = 0
  if (sign(built).status === 0) signed += 1
  for (const f of walk(path.join(outDir, 'risk-api'))) {
    if (f.endsWith('.so') || f.endsWith('.dylib')) {
      if (sign(f).status === 0) signed += 1
    }
  }
  console.log(`[build-backend] ad-hoc signed ${signed} Mach-O files`)
}

// 样例数据随包
fs.rmSync(samplesTarget, { recursive: true, force: true })
fs.mkdirSync(samplesTarget, { recursive: true })
fs.cpSync(path.join(repo, 'data', 'samples'), samplesTarget, { recursive: true })
console.log('[build-backend] done →', built)

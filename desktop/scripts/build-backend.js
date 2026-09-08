/**
 * 用 PyInstaller 打包 Python 后端到 desktop/resources/backend/risk-api.exe
 * 用法：node scripts/build-backend.js
 *
 * 说明：
 *  - 采用 onedir（目录）模式：首启快、不易被杀软误报
 *  - 若未安装 pyinstaller 会给出提示
 *  - 体积较大（pandas/numpy/akshare），首次构建约 3~6 分钟
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..', '..')
const serverDir = path.join(repo, 'server')
const py = path.join(serverDir, '.venv', 'Scripts', 'python.exe')
const outDir = path.join(__dirname, '..', 'resources', 'backend')
const samplesTarget = path.join(__dirname, '..', 'resources', 'samples')

if (!fs.existsSync(py)) {
  console.error('[build-backend] 未找到 Python 虚拟环境：', py)
  console.error('请先执行：cd server && python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt')
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

// 样例数据随包
fs.rmSync(samplesTarget, { recursive: true, force: true })
fs.mkdirSync(samplesTarget, { recursive: true })
fs.cpSync(path.join(repo, 'data', 'samples'), samplesTarget, { recursive: true })
console.log('[build-backend] done →', outDir)

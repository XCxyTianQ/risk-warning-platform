/**
 * 构建 Rust 后端并把单文件二进制放进 desktop/resources/backend/
 * 用法：node scripts/build-backend.js [--target <triple>] [--debug]
 *
 * 为什么这样做：
 *  - Rust 产物是**单个静态二进制**，不再需要 PyInstaller onedir 目录、也不依赖
 *    目标机器的 Python 解释器版本，从根上消除 "Python 版本差异 / 架构匹配" 类兼容问题；
 *  - 体积从 ~180MB（含 pandas/akshare）降到 ~10MB 量级，冷启动更快。
 *
 * 交叉编译约定（CI 里每个 runner 原生构建自己的目标）：
 *  - windows-latest        → x86_64-pc-windows-msvc
 *  - macos-26 (arm64)      → aarch64-apple-darwin
 *  - macos-15-intel (x64)  → x86_64-apple-darwin
 *
 * 环境变量：
 *  - RWP_CARGO    指定 cargo 可执行文件（默认 PATH 上的 cargo）
 *  - RWP_TARGET   cargo --target（默认宿主）
 *  - RWP_SKIP_BUILD=1  跳过构建，仅把已有二进制拷进 resources（本地联调用）
 */
const { execSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const repo = path.resolve(__dirname, '..', '..')
const backendDir = path.join(repo, 'backend')
const outDir = path.join(__dirname, '..', 'resources', 'backend')
const samplesTarget = path.join(__dirname, '..', 'resources', 'samples')
const exeName = isWin ? 'risk-warning-backend.exe' : 'risk-warning-backend'

const argv = process.argv.slice(2)
const debug = argv.includes('--debug')
const targetArg = (() => {
  const i = argv.indexOf('--target')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return process.env.RWP_TARGET || ''
})()

const cargo = process.env.RWP_CARGO || (isWin ? 'cargo.exe' : 'cargo')

console.log(
  '[build-backend] platform:', process.platform, process.arch,
  '| profile:', debug ? 'debug' : 'release',
  '| target:', targetArg || '(host)',
)

// 1) 构建
if (process.env.RWP_SKIP_BUILD !== '1') {
  try {
    execSync(`"${cargo}" --version`, { stdio: 'ignore' })
  } catch {
    console.error('[build-backend] 未找到 cargo。请安装 Rust 工具链：https://rustup.rs')
    process.exit(1)
  }
  const args = ['build', debug ? '' : '--release'].filter(Boolean)
  if (targetArg) args.push('--target', targetArg)
  console.log('[build-backend] running cargo', args.join(' '))
  execSync(`"${cargo}" ${args.join(' ')}`, { cwd: backendDir, stdio: 'inherit' })
}

// 2) 定位产物
const profile = debug ? 'debug' : 'release'
const targetRoot = targetArg
  ? path.join(backendDir, 'target', targetArg, profile)
  : path.join(backendDir, 'target', profile)
const built = path.join(targetRoot, exeName)
if (!fs.existsSync(built)) {
  console.error('[build-backend] 未找到产物：', built)
  process.exit(1)
}

// 3) 拷贝到 resources/backend（保持单文件形态）
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const dest = path.join(outDir, exeName)
fs.copyFileSync(built, dest)
if (!isWin) fs.chmodSync(dest, 0o755)

// 4) macOS：ad-hoc 签名（Gatekeeper/Apple Silicon 要求可执行文件带签名；
//    未签名的二进制在用户机上会被直接杀掉）
if (isMac) {
  const r = spawnSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'ignore' })
  console.log(`[build-backend] ad-hoc codesign: ${r.status === 0 ? 'ok' : 'skipped/failed'}`)
}

// 5) 样例数据随包
fs.rmSync(samplesTarget, { recursive: true, force: true })
fs.mkdirSync(samplesTarget, { recursive: true })
fs.cpSync(path.join(repo, 'data', 'samples'), samplesTarget, { recursive: true })

const sizeMb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1)
console.log(`[build-backend] done → ${dest} (${sizeMb} MB)`)

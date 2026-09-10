/**
 * 企业经营风险预警平台 · Electron 主进程（Windows / macOS）
 *
 * 职责：
 *  1. 单实例锁 + 动态端口
 *  2. 拉起 Rust 后端（打包=resources/backend/risk-warning-backend[.exe]，
 *     开发=backend/target/{release,debug}/…；旧包 Python risk-api 与 venv 仍可兜底）
 *  3. 等待 /api/health 就绪后创建窗口，加载 http://127.0.0.1:<port>
 *  4. 托盘 / 菜单 / 外链用系统浏览器打开
 *  5. 退出时优雅关闭后端进程树（Windows 用 taskkill，POSIX 用进程组信号）
 *
 * 环境变量：
 *  RWP_SMOKE=1      只做"拉起后端 + 健康检查"，成功后退出（用于 CI/自检）
 *  RWP_DEV=1        强制使用开发模式后端
 *  RWP_BACKEND     指定后端可执行文件路径（覆盖自动探测）
 */
const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const SMOKE = process.env.RWP_SMOKE || ''   // '' | '1'（只测后端）| '2'（连窗口一起测）
const isDev = process.env.RWP_DEV === '1' || !app.isPackaged
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

// 固定使用 ASCII 数据目录，便于排查与跨语言环境
// Windows: %APPDATA%\RiskWarningPlatform ；macOS: ~/Library/Application Support/RiskWarningPlatform
app.setName('RiskWarningPlatform')
app.setPath('userData', path.join(app.getPath('appData'), 'RiskWarningPlatform'))

let backend = null
let win = null
let tray = null
let backendPort = 0
let quitting = false

// ---------- 路径 ----------
function resourcePath(...parts) {
  return path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources'), ...parts)
}

function webDist() {
  const packaged = resourcePath('web')
  if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged
  // 开发模式：直接用仓库里的 web/dist
  const repo = path.resolve(__dirname, '..', 'web', 'dist')
  return fs.existsSync(path.join(repo, 'index.html')) ? repo : packaged
}

function samplesDir() {
  const packaged = resourcePath('samples')
  if (fs.existsSync(path.join(packaged, 'dataset.json'))) return packaged
  const repo = path.resolve(__dirname, '..', 'data', 'samples')
  return fs.existsSync(path.join(repo, 'dataset.json')) ? repo : packaged
}

function backendCommand() {
  if (process.env.RWP_BACKEND) {
    return { cmd: process.env.RWP_BACKEND, args: [], cwd: path.dirname(process.env.RWP_BACKEND) }
  }
  const repo = path.resolve(__dirname, '..')
  // Rust 后端：单个静态二进制（risk-warning-backend[.exe]）
  const names = isWin ? ['risk-warning-backend.exe', 'risk-warning-backend'] : ['risk-warning-backend']
  const rustCandidates = []
  for (const n of names) {
    rustCandidates.push(resourcePath('backend', n))
    // 开发模式：直接用仓库里的 target/{release,debug}
    rustCandidates.push(path.join(repo, 'backend', 'target', 'release', n))
    rustCandidates.push(path.join(repo, 'backend', 'target', 'debug', n))
  }
  const rust = rustCandidates.find((p) => fs.existsSync(p))
  if (rust) return { cmd: rust, args: [], cwd: path.dirname(rust) }

  // 兼容旧包：PyInstaller 产物（onedir 或单文件）
  const legacyNames = isWin ? ['risk-api.exe', 'risk-api'] : ['risk-api']
  for (const n of legacyNames) {
    for (const p of [resourcePath('backend', 'risk-api', n), resourcePath('backend', n)]) {
      if (fs.existsSync(p)) {
        console.warn('[main] 使用旧版 Python 后端包（建议用 scripts/build-backend.js 重新打包）')
        return { cmd: p, args: [], cwd: path.dirname(p) }
      }
    }
  }

  // 最后兜底：开发期用 venv 的 python 跑 desktop_entry.py
  const pyCandidates = isWin
    ? [path.join(repo, 'server', '.venv', 'Scripts', 'python.exe')]
    : [path.join(repo, 'server', '.venv', 'bin', 'python3'), path.join(repo, 'server', '.venv', 'bin', 'python')]
  const py = pyCandidates.find((p) => fs.existsSync(p))
  const entry = path.join(repo, 'server', 'desktop_entry.py')
  if (py && fs.existsSync(entry)) {
    console.warn('[main] 未找到 Rust 后端二进制，回退到 Python 后端（仅开发期）')
    return { cmd: py, args: [entry], cwd: path.join(repo, 'server') }
  }
  dialog.showErrorBox(
    '后端缺失',
    `未找到后端二进制。请先构建：\n  cd backend && cargo build --release\n` +
      `或执行：node scripts/build-backend.js\n\n查找路径：\n${rustCandidates.join('\n')}`,
  )
  app.quit()
  return { cmd: '', args: [], cwd: repo }
}

// ---------- 工具 ----------
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

function waitForHealth(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve(true)
        retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('后端启动超时（90s）'))
      setTimeout(ping, 400)
    }
    ping()
  })
}

function killBackend() {
  if (!backend || backend.killed) return
  const pid = backend.pid
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      // POSIX：spawn 时已 detached（自成进程组），先 SIGTERM 再兜底 SIGKILL
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        process.kill(pid, 'SIGTERM')
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch { /* 已退出 */ }
      }, 1500)
    }
  } catch { /* 忽略 */ }
  backend = null
}

// ---------- 后端 ----------
async function startBackend() {
  backendPort = await freePort()
  const dataDir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const { cmd, args, cwd } = backendCommand()
  const fullArgs = [...args, '--port', String(backendPort), '--data-dir', dataDir, '--web-dist', webDist()]
  const logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = fs.openSync(path.join(logDir, 'backend.log'), 'a')

  console.log('[main] starting backend:', cmd, fullArgs.join(' '))
  backend = spawn(cmd, fullArgs, {
    cwd,
    env: { ...process.env, RWP_SAMPLES_DIR: samplesDir(), PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,   // POSIX 下自成进程组，便于整组终止
  })
  backend.stdout.on('data', (d) => { fs.writeSync(logFile, d); console.log('[backend]', String(d).trim()) })
  backend.stderr.on('data', (d) => { fs.writeSync(logFile, d) })
  backend.on('exit', (code) => {
    console.log('[main] backend exited:', code)
    if (!quitting && !SMOKE) {
      dialog.showErrorBox('后端已退出', `后端进程异常退出（code=${code}）。\n日志：${path.join(logDir, 'backend.log')}`)
    }
  })
  await waitForHealth(backendPort)
  console.log('[main] backend ready on', backendPort)
}

// ---------- 窗口 ----------
function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: `企业经营风险预警平台 v${app.getVersion()}`,
    backgroundColor: '#f4f6fb',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.loadURL(`http://127.0.0.1:${backendPort}/`)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => { win = null })

  // 冒烟模式 2：验证窗口能真正加载出页面后退出
  if (SMOKE === '2') {
    win.webContents.on('did-finish-load', async () => {
      try {
        const info = await win.webContents.executeJavaScript(
          `JSON.stringify({ title: document.title, hasApp: !!document.querySelector('#app'), text: (document.body.innerText || '').slice(0, 80) })`,
        )
        console.log('SMOKE_WINDOW_OK ' + info)
      } catch (err) {
        console.log('SMOKE_WINDOW_FAIL ' + err)
      }
      quitting = true
      app.quit()
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`SMOKE_WINDOW_FAIL ${code} ${desc}`)
      quitting = true
      app.quit()
    })
  }
  return win
}

function buildMenu() {
  const template = []
  // macOS：首项必须是应用菜单（含退出），并保留编辑菜单，否则输入框不支持 Cmd+C/V
  if (isMac) {
    template.push({ role: 'appMenu' })
    template.push({ role: 'editMenu' })
  }
  template.push(
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(path.join(app.getPath('userData'), 'data')) },
        { label: '打开日志', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit() } },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: '企业经营风险预警平台',
            detail: `版本 ${app.getVersion()}\n平台 ${process.platform}/${process.arch}\n后端端口 ${backendPort}\n数据目录 ${path.join(app.getPath('userData'), 'data')}`,
          }),
        },
      ],
    },
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  if (!fs.existsSync(iconPath)) return
  let image = nativeImage.createFromPath(iconPath)
  if (isMac) {
    image = image.resize({ width: 18, height: 18 })
    image.setTemplateImage(true)   // macOS 菜单栏随明暗主题自动反色
  } else {
    image = image.resize({ width: 16, height: 16 })
  }
  tray = new Tray(image)
  tray.setToolTip('企业经营风险预警平台')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => (win ? (win.show(), win.focus()) : createWindow()) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  // macOS 菜单栏图标单击即弹菜单，双击事件不触发
  if (isMac) tray.on('click', () => tray.popUpContextMenu())
  else tray.on('double-click', () => (win ? (win.show(), win.focus()) : createWindow()))
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })

  app.whenReady().then(async () => {
    try {
      await startBackend()
    } catch (err) {
      dialog.showErrorBox('启动失败', String(err))
      app.quit()
      return
    }
    if (SMOKE === '1') {
      console.log('SMOKE_OK port=' + backendPort)
      quitting = true
      app.quit()
      return
    }
    buildMenu()
    createWindow()
    createTray()
  })

  app.on('window-all-closed', () => { quitting = true; app.quit() })
  app.on('activate', () => { if (!win) createWindow() })   // macOS 点击 Dock 图标
  app.on('before-quit', () => { quitting = true; killBackend() })
  app.on('will-quit', () => killBackend())
  process.on('exit', () => killBackend())
}

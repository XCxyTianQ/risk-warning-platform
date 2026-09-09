/**
 * 金融分析面板渲染冒烟测试（开发态）：加载 Vite dev server → 点击「金融分析」→ 检查 DOM 与报错。
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-finance.js
 * 前置：web 端 npm run dev（默认 http://localhost:5173），后端 8001 可用。
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://localhost:5173/'
const errors = []

app.on('ready', async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1680,
    height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  win.webContents.on('console-message', (...args) => {
    const d = args[0]
    if (d && typeof d === 'object' && typeof d.message === 'string') {
      if (d.level === 'error' || d.level === 'warning') errors.push(`[${d.level}] ${d.message}`)
      return
    }
    const level = args[1]
    const message = args[2]
    if (typeof level === 'number' && level >= 2) errors.push(`[${level}] ${message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`))
  win.webContents.on('render-process-gone', (_e, details) => errors.push(`render-gone ${JSON.stringify(details)}`))

  try {
    await win.loadURL(URL)
  } catch (e) {
    console.log('LOAD-FAIL', String(e))
    app.quit()
    return
  }
  await new Promise((r) => setTimeout(r, 3500))

  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('button.rail-btn')]
      const b = btns.find((x) => (x.getAttribute('title') || '').includes('金融分析'))
      if (!b) return 'no-button: ' + btns.map((x) => x.getAttribute('title')).join(' | ')
      b.click()
      return 'clicked'
    })()
  `)
  console.log('CLICK:', clicked)

  await new Promise((r) => setTimeout(r, 9000))

  const info = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.innerText || ''
      const canvas = document.querySelectorAll('canvas').length
      return {
        hasTitle: t.includes('金融分析'),
        hasKpi: t.includes('关键指标'),
        hasCharts: t.includes('趋势分析'),
        hasDupont: t.includes('杜邦分解'),
        hasModels: t.includes('财务预警模型'),
        hasAnomaly: t.includes('异常勾稽'),
        hasPeers: t.includes('同业对标'),
        canvasCount: canvas,
        textLen: t.length,
        snippet: t.slice(0, 900),
      }
    })()
  `)
  console.log('INFO:', JSON.stringify(info, null, 1))
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 25), null, 1))
  app.quit()
})

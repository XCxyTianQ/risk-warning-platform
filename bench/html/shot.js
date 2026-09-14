/**
 * 用 Electron 把生成的 HTML 报告渲染成图片，供设计检查（不是评测的一部分）。
 *
 *   node bench/html/shot.js            # 输出 3 张视图（上/中/下）+ 深色模式 1 张
 *
 * 之所以要"真的看一眼"：HTML 报告是给人读的，字号、图表比例、表格换行这些问题
 * 静态检查（查 NaN、查空单元格）发现不了。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'docs', 'reports', 'Benchmark-Platform-Report-v1.html')
const OUT = path.join(REPO, 'bench', 'external', 'out', 'shots')
fs.mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: '01-top', scroll: 0, theme: 'light' },
  { name: '02-finrisk', scroll: 2100, theme: 'light' },
  { name: '03-external', scroll: 4100, theme: 'light' },
  { name: '04-honest', scroll: 6100, theme: 'light' },
  { name: '05-data', scroll: 7250, theme: 'light' },
  { name: '06-cost', scroll: 8500, theme: 'light' },
  { name: '07-conclusion', scroll: 9650, theme: 'light' },
  { name: '08-dark-top', scroll: 0, theme: 'dark' },
]

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 980,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  await win.loadFile(FILE)
  await new Promise((r) => setTimeout(r, 900))
  const height = await win.webContents.executeJavaScript('document.documentElement.scrollHeight')
  const width = await win.webContents.executeJavaScript('document.documentElement.scrollWidth')
  console.log(`页面尺寸：${width} × ${height} px`)

  for (const v of VIEWPORTS) {
    await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','${v.theme}');window.scrollTo(0,${v.scroll});true`)
    await new Promise((r) => setTimeout(r, 320))
    const img = await win.webContents.capturePage()
    const file = path.join(OUT, `${v.name}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log(`  ✅ ${v.name}.png`)
  }
  console.log(`\n截图目录：${path.relative(REPO, OUT)}`)
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })

/** 展示页截图核对：docs/showcase/index.html 分屏截图（Electron，离线）。 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'docs', 'showcase', 'index.html')
const OUT = path.join(REPO, 'bench', 'external', 'out', 'shots-showcase')
fs.mkdirSync(OUT, { recursive: true })

const VIEWS = [
  { name: '01-hero', scroll: 0 },
  { name: '02-finding', sel: '#finding' },
  { name: '03-increment', sel: '#inc' },
  { name: '04-cost', sel: '#cost' },
  { name: '05-radar', sel: '#radar' },
  { name: '06-self', sel: '#self' },
  { name: '07-method', sel: '#method' },
  { name: '08-limits', sel: '#limits' },
]

app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1360, height: 980, show: false, webPreferences: { offscreen: false } })
  await win.loadFile(FILE)
  await new Promise((r) => setTimeout(r, 900))
  // 关键：页面开了 scroll-behavior:smooth，截图前必须关掉，否则 scrollTo 是动画，
  // 700ms 后截到的是滚动途中（取景会随机漂移，同一个选择器两次截出不同内容）
  await win.webContents.executeJavaScript(`document.documentElement.style.scrollBehavior='auto'`)
  // 触发滚动动画与计数
  await win.webContents.executeJavaScript(`(function(){var h=document.documentElement;var y=0;var step=function(){y+=400;window.scrollTo(0,y);if(y<(h.scrollHeight-h.clientHeight))setTimeout(step,40)};step();return new Promise(function(res){setTimeout(function(){window.scrollTo(0,0);res(h.scrollHeight)},1400)})})()`)
  await new Promise((r) => setTimeout(r, 1200))

  for (const v of VIEWS) {
    if (v.sel) {
      const ok = await win.webContents.executeJavaScript(`(function(){var el=document.querySelector(${JSON.stringify(v.sel)});if(!el)return false;var r=el.getBoundingClientRect();var vh=window.innerHeight;window.scrollTo(0,Math.max(0,r.top+window.scrollY-(vh-Math.min(r.height,vh))/2));return true})()`)
      if (!ok) { console.log(`  ⚠️ ${v.name}: 找不到 ${v.sel}`); continue }
    } else {
      await win.webContents.executeJavaScript(`window.scrollTo(0,${v.scroll || 0})`)
    }
    await new Promise((r) => setTimeout(r, 700))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `${v.name}.png`), img.toPNG())
    console.log(`  ✅ ${v.name}.png`)
  }
  console.log(`\n输出目录：${path.relative(REPO, OUT)}`)
  app.quit()
})

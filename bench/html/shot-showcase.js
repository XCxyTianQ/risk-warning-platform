/**
 * 交互页截图核对：默认视图 + 依次切换各视图 + 切换尺度与隐藏模型后的雷达形态。
 * 关键：截图前必须关掉 scroll-behavior，且切换视图后要等 JS 重绘完成。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'docs', 'showcase', 'index.html')
const OUT = path.join(REPO, 'bench', 'external', 'out', 'shots-showcase')
fs.mkdirSync(OUT, { recursive: true })

app.commandLine.appendSwitch('force-device-scale-factor', '1')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 940, show: false })
  await win.loadFile(FILE)
  await wait(1000)
  const shot = async (name) => {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG())
    console.log(`  ✅ ${name}.png`)
  }

  await shot('01-radar-zoom')

  // 切到绝对尺度
  await win.webContents.executeJavaScript(`document.querySelector('#scaleSeg button[data-s="abs"]').click()`)
  await wait(500)
  await shot('02-radar-abs')

  // 切回拉开尺度并聚焦某模型（悬停对应行）
  await win.webContents.executeJavaScript(`document.querySelector('#scaleSeg button[data-s="zoom"]').click()`)
  await wait(400)
  await win.webContents.executeJavaScript(`(function(){var r=document.querySelectorAll('.legendRow')[0];if(r)r.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));return true})()`)
  await wait(400)
  await shot('03-radar-focus')

  // 范围切到五家
  await win.webContents.executeJavaScript(`(function(){var r=document.querySelectorAll('.legendRow')[0];if(r)r.dispatchEvent(new MouseEvent('mouseleave',{bubbles:true}));document.querySelectorAll('#setSeg button')[1].click();return true})()`)
  await wait(500)
  await shot('04-radar-five')

  // 其它视图
  for (const [v, name] of [['memory', '05-memory'], ['cost', '06-cost'], ['self', '07-self'], ['limits', '08-limits']]) {
    await win.webContents.executeJavaScript(`document.querySelector('#nav button[data-v="${v}"]').click()`)
    await wait(700)
    await shot(name)
  }
  console.log(`\n输出目录：${path.relative(REPO, OUT)}`)
  app.quit()
})

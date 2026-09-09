/**
 * 对话链路 UI 冒烟测试：发一条真实提问，验证
 *  1) 思考过程块（reasoning）出现并流式增长
 *  2) 已用时计时器 / 耗时脚注
 *  3) 工具卡片显示耗时
 *  4) 最终回答正常渲染
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-chat.js
 * 前置：web 端 npm run dev（5173）、后端 8001 可用。
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://localhost:5173/'
const QUESTION = process.env.SMOKE_QUESTION || '康美药业现在风险怎么样？简要说明依据'
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
      if (d.level === 'error') errors.push(`[error] ${d.message}`)
      return
    }
    if (typeof args[1] === 'number' && args[1] >= 2) errors.push(`[${args[1]}] ${args[2]}`)
  })

  try {
    await win.loadURL(URL)
  } catch (e) {
    console.log('LOAD-FAIL', String(e))
    app.quit()
    return
  }
  await new Promise((r) => setTimeout(r, 3000))

  const sent = await win.webContents.executeJavaScript(`
    (async () => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(QUESTION)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 400))
      const btns = [...document.querySelectorAll('button')]
      const send = btns.find((b) => b.textContent.trim() === '发送')
      if (!send) return 'no-send-button'
      if (send.disabled) return 'send-disabled(输入未同步)'
      send.click()
      await new Promise((r) => setTimeout(r, 600))
      const shown = (document.body.innerText || '').includes(${JSON.stringify(QUESTION)}.slice(0, 12))
      return shown ? 'sent' : 'clicked-but-not-shown'
    })()
  `)
  console.log('SEND:', sent)

  const snapshots = []
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1200 : 2500))
    const snap = await win.webContents.executeJavaScript(`
      (() => {
        const t = document.body.innerText || ''
        return {
          reasoning: t.includes('正在思考') || t.includes('思考过程'),
          reasoningChars: (t.match(/思考过程[\\s\\S]{0,20}?(\\d+) 字/) || [])[1] || null,
          timer: (t.match(/已用时\\s*([\\d.]+s|\\d+ms)/) || [])[1] || null,
          foot: (t.match(/⏱\\s*([\\d.]+s|\\d+ms)/g) || []).slice(-1)[0] || null,
          toolMs: (t.match(/\\(\\d+ms\\)|\\d+\\.\\d+s/g) || []).length,
          hasAnswer: t.includes('风险'),
          streaming: t.includes('停止'),
          tail: t.slice(-260).replace(/\\n/g, ' | '),
        }
      })()
    `)
    snapshots.push(snap)
    if (!snap.streaming && i > 0) break
  }

  console.log('SNAPSHOTS:', JSON.stringify(snapshots, null, 1))
  const last = snapshots[snapshots.length - 1] || {}
  console.log('RESULT:', JSON.stringify({
    reasoning_seen: snapshots.some((s) => s.reasoning),
    timer_seen: snapshots.some((s) => s.timer),
    foot_seen: !!last.foot,
    answer_seen: !!last.hasAnswer,
    finished: !last.streaming,
  }))
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 10), null, 1))
  app.quit()
})

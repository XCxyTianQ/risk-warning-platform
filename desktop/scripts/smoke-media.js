/**
 * 多模态输入冒烟：对话粘贴图片 → 上传 → 发送 → 缩略图与回答；表格「从图片识别」→ 待确认 → 确认 → 入库。
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-media.js
 * 前置：SMOKE_URL 指向可用后端（真实模型），SMOKE_IMAGE 指定测试图片
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8254/'
const IMAGE =
  process.env.SMOKE_IMAGE ||
  path.resolve(__dirname, '..', '..', 'data', 'samples', 'finance_table_demo.png')
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`))

  await win.loadURL(URL)
  await sleep(3500)

  const b64 = fs.readFileSync(IMAGE).toString('base64')

  // ---------- 1) 对话粘贴图片 ----------
  const pasted = await win.webContents.executeJavaScript(`
    (async () => {
      const bin = atob(${JSON.stringify(b64)})
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const file = new File([bytes], 'finance_table_demo.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const ta = document.querySelector('.composer textarea')
      if (!ta) return 'no-textarea'
      ta.focus()
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 2500))
      const chips = [...document.querySelectorAll('.composer .chip')]
      return { chips: chips.length, names: chips.map((c) => c.querySelector('.chip-name')?.textContent) }
    })()
  `)
  console.log('PASTE:', JSON.stringify(pasted))

  const sent = await win.webContents.executeJavaScript(`
    (async () => {
      const ta = document.querySelector('.composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '这张图里是什么？用一句话说明，并给出图里的营业收入数值')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const btn = [...document.querySelectorAll('.composer button')].find((b) => b.textContent.includes('发送'))
      if (!btn) return 'no-send'
      btn.click()
      return 'sent'
    })()
  `)
  console.log('SEND:', sent)
  await sleep(18000)

  const chat = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.textContent || ''
      const imgs = [...document.querySelectorAll('.msg-atts img')]
      const cards = [...document.querySelectorAll('.tool-card .tool-name')].map((x) => x.textContent.trim())
      return {
        userThumbs: imgs.length,
        firstThumbSrc: imgs[0] ? imgs[0].getAttribute('src') : '',
        thumbLoaded: imgs[0] ? imgs[0].naturalWidth > 0 : false,
        toolCards: cards,
        answered: t.length > 400,
        hasAttachmentWord: t.includes('附图') || t.includes('附件'),
        textLen: t.length,
      }
    })()
  `)
  console.log('CHAT:', JSON.stringify(chat, null, 1))

  // ---------- 2) 表格：从图片识别 ----------
  await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
      if (b) b.click()
      return !!b
    })()
  `)
  await sleep(1200)

  const created = await win.webContents.executeJavaScript(`
    (async () => {
      const byText = (sel, t) => [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(t))
      const add = byText('button', '新建表格')
      if (!add) return 'no-create-button'
      add.click()
      await new Promise((r) => setTimeout(r, 400))
      const card = document.querySelector('.modal-card')
      const entSel = [...card.querySelectorAll('select')][1]
      const opt = [...entSel.options].find((o) => (o.textContent || '').trim() !== '未绑定')
      if (opt) {
        entSel.value = opt.value
        entSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await new Promise((r) => setTimeout(r, 200))
      const confirm = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '创建')
      confirm.click()
      await new Promise((r) => setTimeout(r, 2000))
      return document.querySelector('table.grid') ? 'editor-open' : 'no-grid'
    })()
  `)
  console.log('TABLE CREATE:', created)

  // 用 CDP 给隐藏的 file input 赋文件（模拟用户选图）——真实走「从图片识别」按钮
  let picked = 'skipped'
  try {
    win.webContents.debugger.attach('1.3')
    const doc = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file][accept="image/*"]',
    })
    if (nodeId) {
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
        files: [IMAGE],
        nodeId,
      })
      picked = 'file-set'
    } else {
      picked = 'input-not-found'
    }
  } catch (e) {
    picked = 'cdp-error: ' + String(e).slice(0, 120)
  }
  console.log('PICK:', picked)
  await sleep(25000) // 等模型识别

  const reading = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.textContent || ''
      const modal = document.querySelector('.modal-card')
      const rows = modal ? [...modal.querySelectorAll('tbody tr')].map((tr) => (tr.textContent || '').replace(/\\s+/g, ' ').trim()) : []
      const grid = document.querySelector('table.grid')
      const visionCells = grid
        ? [...grid.querySelectorAll('td.cell')].filter((td) => td.querySelector('.src.vision')).length
        : 0
      const confirmBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('确认识别结果'))
      return {
        modalOpen: !!modal,
        modalRows: rows.slice(0, 6),
        visionCells,
        confirmButton: !!confirmBtn,
        bannerText: (document.querySelector('.banner')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
        hasUnconfirmed: t.includes('尚未确认'),
      }
    })()
  `)
  console.log('READING:', JSON.stringify(reading, null, 1))

  // ---------- 3) 确认 → 入库可用 ----------
  const confirmed = await win.webContents.executeJavaScript(`
    (async () => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('确认识别结果'))
      const close = [...document.querySelectorAll('.modal-card button')].find((b) => (b.textContent || '').trim() === '知道了')
      if (close) close.click()
      await new Promise((r) => setTimeout(r, 300))
      if (!btn) return 'no-confirm-button'
      btn.click()
      await new Promise((r) => setTimeout(r, 2500))
      const t = document.body.textContent || ''
      const ingest = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('入库…'))
      return { after: t.includes('已确认') || !t.includes('尚未确认'), ingestEnabled: !!ingest }
    })()
  `)
  console.log('CONFIRM:', JSON.stringify(confirmed))

  console.log('ERRORS:', JSON.stringify(errors.slice(0, 15), null, 1))
  app.quit()
})

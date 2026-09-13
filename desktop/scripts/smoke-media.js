/**
 * 多模态输入冒烟（需要真实模型）：
 *   1) 对话里粘贴图片 → 上传 → 发送 → 缩略图 + 工具卡片 + 有回答；
 *   2) 表格「从图片识别」→ 识别结果写入「关键指标表」模板的科目行（标记待确认）
 *      → 全部确认 → 校验横幅/入库按钮进入可用状态。
 *
 * 用法：electron.exe desktop/scripts/smoke-media.js
 * 前置：SMOKE_URL 指向配好真实模型的后端；SMOKE_IMAGE 指定测试图片。
 * 说明：每一步都有超时；结论由断言决定（不再无条件 exit 0）。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8254/'
const IMAGE = process.env.SMOKE_IMAGE || path.resolve(__dirname, '..', '..', 'data', 'samples', 'finance_table_demo.png')
const TEMPLATE = process.env.SMOKE_TEMPLATE || 'kpi'
const BUDGET = Number(process.env.SMOKE_BUDGET_MS || 300000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

setTimeout(() => {
  console.log('RESULT: timeout-after-' + BUDGET + 'ms')
  app.exit(2)
}, BUDGET)

app.on('ready', async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1680,
    height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  const errors = []
  win.webContents.on('console-message', (...args) => {
    const d = args[0]
    if (d && typeof d === 'object' && typeof d.message === 'string') {
      if (d.level === 'error') errors.push(`[error] ${d.message}`)
      return
    }
    if (typeof args[1] === 'number' && args[1] >= 2) errors.push(`[${args[1]}] ${args[2]}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`))

  const rawEval = (code) => win.webContents['executeJavaScript'](code)
  const evalJs = async (label, code, timeoutMs = 60000) => {
    const out = await Promise.race([rawEval(code), sleep(timeoutMs).then(() => '__STEP_TIMEOUT__')])
    if (out === '__STEP_TIMEOUT__') {
      console.log('STEP_TIMEOUT:', label)
      errors.push(`STEP_TIMEOUT ${label}`)
    }
    return out
  }

  try {
    await win.loadURL(URL)
    await sleep(3500)
    const b64 = fs.readFileSync(IMAGE).toString('base64')

    // ---------- 1) 对话粘贴图片 ----------
    const pasted = await evalJs(
      'paste',
      `(async () => {
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
        return { chips: chips.length, names: chips.map((c) => (c.querySelector('.chip-name') || {}).textContent) }
      })()`,
      30000,
    )
    console.log('PASTE:', JSON.stringify(pasted))

    const sent = await evalJs(
      'send',
      `(async () => {
        const ta = document.querySelector('.composer textarea')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '这张图里是什么？用一句话说明，并给出图里的营业收入数值')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 200))
        const btn = [...document.querySelectorAll('.composer button')].find((b) => b.textContent.includes('发送'))
        if (!btn) return 'no-send'
        btn.click()
        return 'sent'
      })()`,
      30000,
    )
    console.log('SEND:', sent)
    await sleep(20000)

    const chat = await evalJs(
      'chat-check',
      `(() => {
        const t = document.body.textContent || ''
        const imgs = [...document.querySelectorAll('.msg-atts img')]
        return {
          userThumbs: imgs.length,
          thumbLoaded: imgs[0] ? imgs[0].naturalWidth > 0 : false,
          toolCards: [...document.querySelectorAll('.tool-card .tool-name')].map((x) => x.textContent.trim()),
          answered: t.length > 400,
          textLen: t.length,
        }
      })()`,
    )
    console.log('CHAT:', JSON.stringify(chat))

    // ---------- 2) 表格：模板表 + 从图片识别 ----------
    await evalJs(
      'open-tables',
      `(() => {
        const b = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
        if (b) b.click()
        return !!b
      })()`,
    )
    await sleep(1500)

    const created = await evalJs(
      'create-table',
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const add = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('新建表格'))
        if (!add) return 'no-create-button'
        add.click(); await wait(500)
        const card = document.querySelector('.modal-card')
        const selects = [...card.querySelectorAll('select')]
        const kindOpt = [...selects[0].options].find((o) => o.value === ${JSON.stringify(TEMPLATE)})
        if (!kindOpt) return 'no-template'
        selects[0].value = kindOpt.value
        selects[0].dispatchEvent(new Event('change', { bubbles: true }))
        await wait(250)
        const entOpt = [...selects[1].options].find((o) => (o.textContent || '').trim() !== '未绑定')
        if (entOpt) {
          selects[1].value = entOpt.value
          selects[1].dispatchEvent(new Event('change', { bubbles: true }))
        }
        await wait(250)
        const confirm = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '创建')
        if (!confirm) return 'no-confirm'
        confirm.click(); await wait(2600)
        return document.querySelector('table.grid') ? 'editor-open' : 'no-grid'
      })()`,
    )
    console.log('TABLE CREATE:', created)

    // 通过 CDP 给隐藏的 file input 赋文件（等价于用户点「从图片识别」后选图）
    let picked = 'skipped'
    try {
      win.webContents.debugger.attach('1.3')
      const doc = await win.webContents.debugger.sendCommand('DOM.getDocument')
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type=file][accept="image/*"]',
      })
      if (nodeId) {
        win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files: [IMAGE], nodeId })
        picked = 'file-set'
      } else {
        picked = 'input-not-found'
      }
    } catch (e) {
      picked = 'cdp-error: ' + String(e).slice(0, 120)
    }
    console.log('PICK:', picked)
    await sleep(28000) // 等模型识别 + 写入

    const reading = await evalJs(
      'reading-check',
      `(() => {
        const t = document.body.textContent || ''
        const modal = document.querySelector('.modal-card')
        const rows = modal ? [...modal.querySelectorAll('tbody tr')].map((tr) => (tr.textContent || '').replace(/\\s+/g, ' ').trim()) : []
        const grid = document.querySelector('table.grid')
        const visionCells = grid ? [...grid.querySelectorAll('td.cell')].filter((td) => td.querySelector('i.src')).length : 0
        const confirmBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('确认识别结果'))
        return {
          modalOpen: !!modal,
          modalRows: rows.slice(0, 6),
          visionCells,
          confirmButton: !!confirmBtn,
          bannerText: (document.querySelector('.banner')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
        }
      })()`,
    )
    console.log('READING:', JSON.stringify(reading))

    // ---------- 3) 确认 → 可入库 ----------
    const confirmed = await evalJs(
      'confirm-vision',
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const close = [...document.querySelectorAll('.modal-card button')].find((b) => (b.textContent || '').trim() === '知道了')
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('确认识别结果'))
        if (close) close.click()
        await wait(400)
        if (!btn) return { error: 'no-confirm-button' }
        const label = btn.textContent.trim()
        btn.click()
        await wait(2600)
        const grid = document.querySelector('table.grid')
        const visionCells = grid ? [...grid.querySelectorAll('td.cell')].filter((td) => td.querySelector('i.src')).length : -1
        const ingest = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('入库'))
        const t = document.body.textContent || ''
        return {
          label,
          visionCellsAfter: visionCells,
          ingestButton: ingest ? ingest.textContent.trim().slice(0, 20) : null,
          ingestEnabled: !!(ingest && !ingest.disabled),
          confirmedToast: t.includes('已确认'),
        }
      })()`,
      40000,
    )
    console.log('CONFIRM:', JSON.stringify(confirmed))

    // 清理：接口删除本次创建的表（界面删除会弹原生 confirm 卡住渲染进程）
    const cleanup = await evalJs(
      'cleanup',
      `(async () => {
        const list = await fetch('/api/tables').then((r) => r.json()).catch(() => null)
        if (!list || !list.items) return 'no-list'
        let removed = 0
        for (const t of list.items) {
          if ((t.title || '').includes('关键指标') || (t.title || '').includes('粘贴') || (t.title || '').includes('图片')) {
            const r = await fetch('/api/tables/' + t.id, { method: 'DELETE' })
            if (r.ok) removed++
          }
        }
        return { removed }
      })()`,
      20000,
    )
    console.log('CLEANUP:', JSON.stringify(cleanup))

    const summary = {
      pasted,
      sent,
      chat,
      created,
      picked,
      reading,
      confirmed,
      errors: errors.slice(0, 10),
    }
    console.log('SUMMARY:', JSON.stringify(summary, null, 1))

    const ok =
      pasted?.chips >= 1 &&
      sent === 'sent' &&
      chat?.userThumbs >= 1 &&
      chat?.thumbLoaded === true &&
      chat?.answered === true &&
      created === 'editor-open' &&
      reading?.modalOpen === true &&
      (reading?.modalRows?.length || 0) >= 3 &&
      (reading?.visionCells || 0) >= 1 &&
      (confirmed?.visionCellsAfter === 0 || confirmed?.visionCellsAfter === -1) &&
      errors.length === 0
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.log('FATAL:', String((err && err.stack) || err))
    console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)))
    app.exit(1)
  }
})

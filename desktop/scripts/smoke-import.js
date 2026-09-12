/**
 * 表格导入与撤销冒烟：粘贴 TSV 建表 → 单元格编辑 → Ctrl+Z 撤销 → 校验 → 入库。
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-import.js
 * 前置：SMOKE_URL 指向可用后端（无需模型）
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8258/'
const TSV = [
  '科目\t2025年报\t2024年报',
  '营业总收入\t128600\t96300',
  '归属于母公司股东的净利润\t-12300\t-5400',
  '资产总计\t356800\t301000',
  '负债合计\t176700\t138460',
  '所有者权益合计\t180100\t162540',
  '经营活动产生的现金流量净额\t-8200\t4300',
].join('\n')

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

  await win.loadURL(URL)
  await sleep(3000)

  // 打开表格面板 → 导入弹窗 → 粘贴 TSV → 解析建表
  const imported = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const rail = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
      if (!rail) return 'no-rail'
      rail.click()
      await wait(1000)
      const open = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('导入文件 / 粘贴'))
      if (!open) return 'no-import-button'
      open.click()
      await wait(400)
      const card = document.querySelector('.modal-card.wide')
      const ta = card.querySelector('textarea.paste-box')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(TSV)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const entSel = card.querySelectorAll('select')[0]
      const opt = [...entSel.options].find((o) => (o.textContent || '').trim() !== '未绑定')
      if (opt) { entSel.value = opt.value; entSel.dispatchEvent(new Event('change', { bubbles: true })) }
      await wait(200)
      const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('解析并建表'))
      if (!btn) return 'no-parse-button'
      btn.click()
      await wait(2500)
      const grid = document.querySelector('table.grid')
      const rows = grid ? [...grid.querySelectorAll('tbody tr')].map((tr) => (tr.querySelector('th input')?.value || '').trim()) : []
      const first = grid ? (grid.querySelector('tbody tr td.cell')?.textContent || '').trim() : ''
      return { grid: !!grid, rows: rows.slice(0, 8), firstCell: first }
    })()
  `)
  console.log('IMPORT:', JSON.stringify(imported, null, 1))

  // 编辑一个单元格 → 撤销
  const undone = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const grid = document.querySelector('table.grid')
      const row = [...grid.querySelectorAll('tbody tr')].find((tr) => (tr.querySelector('th input')?.value || '').includes('营业总收入'))
      const td = row.querySelector('td.cell')
      const before = td.textContent.trim()
      td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      td.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await wait(200)
      const input = td.querySelector('input.cell-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '999999')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(1500)
      const afterEdit = [...grid.querySelectorAll('tbody tr')].find((tr) => (tr.querySelector('th input')?.value || '').includes('营业总收入')).querySelector('td.cell').textContent.trim()
      const undoBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('撤销'))
      const canUndo = undoBtn && !undoBtn.disabled
      if (canUndo) undoBtn.click()
      await wait(1500)
      const afterUndo = [...grid.querySelectorAll('tbody tr')].find((tr) => (tr.querySelector('th input')?.value || '').includes('营业总收入')).querySelector('td.cell').textContent.trim()
      return { before, afterEdit, canUndo, afterUndo, restored: before === afterUndo }
    })()
  `)
  console.log('UNDO:', JSON.stringify(undone, null, 1))

  // 校验 + 入库
  const final = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const t = document.body.textContent || ''
      const ok = t.includes('勾稽校验通过')
      const ingest = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('入库…'))
      if (!ingest) return { ok, error: 'no-ingest-button', banner: (document.querySelector('.banner')?.textContent || '').slice(0, 200) }
      ingest.click()
      await wait(600)
      const confirm = [...document.querySelectorAll('.modal-card button')].find((b) => (b.textContent || '').trim() === '确认入库')
      if (!confirm) return { ok, error: 'no-confirm' }
      confirm.click()
      await wait(2500)
      const tt = document.body.textContent || ''
      return { ok, ingested: tt.includes('已入库'), toast: (tt.match(/新增 \\d+ 期[^\\n]{0,40}/) || [''])[0] }
    })()
  `)
  console.log('FINAL:', JSON.stringify(final, null, 1))
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 10), null, 1))
  app.quit()
})

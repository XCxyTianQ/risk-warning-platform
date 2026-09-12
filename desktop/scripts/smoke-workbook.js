/**
 * 工作簿冒烟：空白表格创建 → 自由填写列/行标题 → 多工作表页签 → 数据透视表 → 宏。
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-workbook.js
 * 前置：SMOKE_URL 指向可用后端（无需模型）
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8265/'
const errors = []
const results = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function guard(label, fn, timeoutMs = 40000) {
  let timer
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    results[label] = value
    console.log(label + ':', typeof value === 'string' ? value : JSON.stringify(value))
    return value
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    results[label] = { error: msg }
    console.log(label + ': FAILED ' + msg)
    errors.push(`${label}: ${msg}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

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

  try {
    await win.loadURL(URL)
  } catch (e) {
    console.log('LOAD-THREW ' + String(e))
    app.quit()
    return
  }
  await sleep(3000)

  // ---------- 1) 新建空白表格 ----------
  await guard('BLANK', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const rail = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
        if (!rail) return { error: 'no-rail' }
        rail.click()
        await wait(1000)
        const add = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('新建表格'))
        if (!add) return { error: 'no-create-button' }
        add.click()
        await wait(400)
        const card = document.querySelector('.modal-card')
        const kindSel = card.querySelector('select')
        const options = [...kindSel.options].map((o) => o.textContent.trim())
        const confirm = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '创建')
        confirm.click()
        await wait(2500)
        const grid = document.querySelector('.sheet table.grid')
        const firstHead = grid ? grid.querySelector('thead th.col-head input.head-input') : null
        return {
          kindOptions: options,
          defaultKind: kindSel.value,
          grid: !!grid,
          rows: grid ? grid.querySelectorAll('tbody tr').length : 0,
          cols: grid ? grid.querySelectorAll('thead th.col-head').length : 0,
          firstColLabel: firstHead ? firstHead.value : null,
          sheetTabs: [...document.querySelectorAll('.sheet-tab')].map((b) => (b.textContent || '').trim()),
        }
      })()`,
    ),
  )

  // ---------- 2) 自由填写列标题 + 行标题 + 数值 ----------
  await guard('FREE_FORM', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const grid = document.querySelector('.sheet table.grid')
        const headInput = grid.querySelector('thead th.col-head input.head-input')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(headInput, '科目')
        headInput.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(1200)
        const heads = [...document.querySelectorAll('.sheet table.grid thead th.col-head input.head-input')]
        const second = heads[1]
        setter.call(second, '2025')
        second.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(1200)
        // 行标题
        const rowInput = document.querySelector('.sheet table.grid tbody th input.mini.label')
        setter.call(rowInput, '营业总收入')
        rowInput.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(1200)
        // 填一个数值
        const cell = document.querySelector('.sheet table.grid tbody tr td.cell')
        cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await wait(250)
        const input = cell.querySelector('input.cell-input')
        const setter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter2.call(input, '128600')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(1200)
        const headsNow = [...document.querySelectorAll('.sheet table.grid thead th.col-head input.head-input')].map((i) => i.value)
        const rowsNow = [...document.querySelectorAll('.sheet table.grid tbody th input.mini.label')].map((i) => i.value)
        return { heads: headsNow, firstRowLabel: rowsNow[0], cell: (document.querySelector('.sheet table.grid tbody tr td.cell .cell-text') || {}).textContent || '' }
      })()`,
    ),
  )

  // ---------- 3) 多工作表：新增页签 ----------
  await guard('SHEETS', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const addBtn = [...document.querySelectorAll('.sheet-tabs button')].find((b) => (b.textContent || '').trim() === '＋')
        if (!addBtn) return { error: 'no-add-sheet' }
        // 面板里的 prompt 用 window.prompt 替换（自动化环境无法交互）
        window.prompt = () => '附表A'
        addBtn.click()
        await wait(2200)
        const tabs = [...document.querySelectorAll('.sheet-tab')].map((b) => (b.textContent || '').trim())
        const activeTab = (document.querySelector('.sheet-tab.active') || {}).textContent || ''
        const grid = document.querySelector('.sheet table.grid')
        return { tabs, active: activeTab.trim(), rows: grid ? grid.querySelectorAll('tbody tr').length : 0 }
      })()`,
    ),
  )

  // ---------- 4) 数据透视表 ----------
  await guard('PIVOT', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        window.prompt = () => '透视结果'
        // 回到第一个工作表（有数据的那张）
        const tabs = [...document.querySelectorAll('.sheet-tab')]
        tabs[0].click()
        await wait(1500)
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('透视表'))
        if (!btn) return { error: 'no-pivot-button' }
        btn.click()
        await wait(700)
        const card = document.querySelector('.modal-card.wide')
        const selects = [...card.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent.trim()))
        const rows = [...card.querySelectorAll('table.pivot tbody tr')].map((tr) => (tr.textContent || '').replace(/\\s+/g, ' ').trim())
        const insert = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('插入为新工作表'))
        insert.click()
        await wait(2500)
        const tabsNow = [...document.querySelectorAll('.sheet-tab')].map((b) => (b.textContent || '').trim())
        return { fields: selects[0] ? selects[0].slice(0, 4) : [], previewRows: rows.slice(0, 3), tabsAfterInsert: tabsNow }
      })()`,
    ),
  )

  // ---------- 5) 宏 ----------
  await guard('MACRO', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const tabs = [...document.querySelectorAll('.sheet-tab')]
        tabs[0].click()
        await wait(1500)
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '⚙ 宏')
        if (!btn) return { error: 'no-macro-button' }
        btn.click()
        await wait(600)
        const card = document.querySelector('.modal-card.wide')
        const list = [...card.querySelectorAll('.macro-item b')].map((b) => (b.textContent || '').trim())
        const run = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('运行宏'))
        run.click()
        await wait(3000)
        const logs = [...document.querySelectorAll('.macro-logs li')].map((l) => (l.textContent || '').trim())
        const err = (document.querySelector('.error-box') || {}).textContent || ''
        const heads = [...document.querySelectorAll('.sheet table.grid thead th.col-head input.head-input')].map((i) => i.value)
        return { builtinMacros: list.length, names: list.slice(0, 6), logs, error: err.trim().slice(0, 120), headsAfter: heads }
      })()`,
    ),
  )

  console.log('SUMMARY:', JSON.stringify({ results, errors: errors.slice(0, 8) }, null, 1))
  app.quit()
})

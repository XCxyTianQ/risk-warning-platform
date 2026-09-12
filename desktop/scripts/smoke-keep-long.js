/**
 * 长表导入（不透视）→ 数据透视表 → 插入为新工作表 的 UI 冒烟。
 * 覆盖目标里的第 (3) 项：导入的长表（年度|科目|数值）既能原样保留，也能在界面里自己透视。
 * 用法：electron.exe desktop/scripts/smoke-keep-long.js
 *   SMOKE_URL 默认 http://127.0.0.1:8265/
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8265/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (label, value) => console.log(label + ':', typeof value === 'string' ? value : JSON.stringify(value))

setTimeout(() => { console.log('RESULT: timeout'); app.exit(2) }, 120000)

const LONG_TSV = [
  '年度\t科目\t数值',
  '2025\t营业总收入\t128600',
  '2025\t营业成本\t96300',
  '2024\t营业总收入\t110000',
  '2024\t营业成本\t88000',
].join('\n')

app.on('ready', async () => {
  const win = new BrowserWindow({ show: true, width: 1600, height: 950 })
  const errors = []
  win.webContents.on('console-message', (...args) => {
    const d = args[0]
    if (d && typeof d === 'object' && typeof d.message === 'string' && d.level === 'error') errors.push('[error] ' + d.message)
  })
  await win.loadURL(URL)
  await sleep(3000)

  const rawEval = (code) => win.webContents['executeJavaScript'](code)
  const evalJs = async (code) => {
    try {
      const out = await Promise.race([rawEval(code), sleep(15000).then(() => '__STEP_TIMEOUT__')])
      if (out === '__STEP_TIMEOUT__') console.log('STEP_TIMEOUT:', String(code).slice(0, 60).replace(/\s+/g, ' '))
      return out
    } catch (e) {
      console.log('STEP_ERROR:', String((e && e.message) || e).slice(0, 200))
      return null
    }
  }
  const setInput = (selector, value) => `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'no-el'
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()
  `

  const opened = await evalJs(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const rail = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
      if (!rail) return 'no-rail'
      rail.click(); await wait(1200)
      return document.querySelector('.page') ? 'ok' : 'no-page'
    })()
  `)
  log('OPEN_TABLES', opened)

  // ---------- 1) 导入长表：勾上「长表原样导入」 ----------
  const imported = await evalJs(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('导入文件'))
      if (!btn) return 'no-import-button'
      btn.click(); await wait(500)
      const chk = [...document.querySelectorAll('.modal-card input[type=checkbox]')][0]
      if (!chk) return 'no-checkbox'
      if (!chk.checked) chk.click()
      const ta = document.querySelector('.modal-card textarea')
      if (!ta) return 'no-textarea'
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(LONG_TSV)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(200)
      const go = [...document.querySelectorAll('.modal-card button')].find((b) => (b.textContent || '').includes('解析并建表'))
      if (!go) return 'no-submit'
      go.click()
      await wait(3500)
      return document.querySelector('.sheet table.grid') ? 'ok' : 'no-grid'
    })()
  `)
  log('IMPORT_LONG', imported)

  const shape = await evalJs(`
    (() => {
      const root = document.querySelector('.zone-maxed') || document
      const heads = [...root.querySelectorAll('.sheet table.grid thead th input.head-input')].map((i) => i.value)
      const rowLabels = [...root.querySelectorAll('.sheet table.grid tbody th input.mini.label')].map((i) => i.value)
      const firstRow = [...root.querySelectorAll('.sheet table.grid tbody tr')][0]
      const cells = firstRow ? [...firstRow.querySelectorAll('td.cell .cell-text')].map((c) => c.textContent.trim()) : []
      return { heads: heads, rowLabels: rowLabels, firstRow: cells,
               rows: root.querySelectorAll('.sheet table.grid tbody tr').length }
    })()
  `)
  log('LONG_SHAPE', shape)
  const keptLong = JSON.stringify(shape?.heads || []).includes('科目') && JSON.stringify(shape?.heads || []).includes('数值')
  log('KEPT_LONG', keptLong)

  // ---------- 2) 用透视表把它变成矩阵并插入为新工作表 ----------
  const pivoted = await evalJs(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('透视表'))
      if (!btn) return 'no-pivot-button'
      btn.click(); await wait(700)
      const card = document.querySelector('.modal-card.wide') || document.querySelector('.modal-card')
      const selects = [...card.querySelectorAll('select')]
      if (selects.length < 4) return 'no-selects:' + selects.length
      const pick = (sel, matcher) => {
        const opt = [...sel.options].find((o) => matcher(o.textContent))
        if (!opt) return false
        sel.value = opt.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
      pick(selects[0], (t) => t.includes('科目'))
      pick(selects[1], (t) => t.includes('年度'))
      pick(selects[2], (t) => t.includes('数值'))
      await wait(600)
      const preview = [...card.querySelectorAll('table.pivot tbody tr')].map((tr) =>
        [...tr.children].map((td) => td.textContent.trim()).join('/'))
      const go = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('插入为新工作表'))
      if (!go) return 'no-insert'
      go.click(); await wait(2000)
      const tabs = [...document.querySelectorAll('.card.sheet-tabs .sheet-tab')].map((b) => b.textContent.trim())
      return { preview: preview, tabs: tabs }
    })()
  `)
  log('PIVOT', pivoted)

  const cleanup = await evalJs(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const back = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('返回列表'))
      if (back) { back.click(); await wait(1200) }
      const rows = [...document.querySelectorAll('tr.clickable')]
      const row = rows[0]
      if (!row) return 'no-rows'
      const del = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').includes('删除'))
      if (!del) return 'no-delete'
      del.click(); await wait(1200)
      return { remaining: document.querySelectorAll('tr.clickable').length }
    })()
  `)
  log('CLEANUP', cleanup)

  log('ERRORS', errors.slice(0, 8))
  app.exit(0)
})

/**
 * 财报表格面板冒烟测试：打开「财报表格」→ 新建表格 → 录入单元格 → 勾稽校验 → 入库弹窗。
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-tables.js
 * 前置：SMOKE_URL 指向可用的后端（后端同时托管前端构建产物），例如 http://127.0.0.1:8252/
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8252/'
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

  try {
    await win.loadURL(URL)
  } catch (e) {
    console.log('LOAD-FAIL', String(e))
    app.quit()
    return
  }
  await sleep(3500)

  // 1) 打开面板
  const opened = await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('button.rail-btn')]
      const b = btns.find((x) => (x.getAttribute('title') || '').includes('财报表格'))
      if (!b) return 'no-button: ' + btns.map((x) => x.getAttribute('title')).join(' | ')
      b.click()
      return 'clicked'
    })()
  `)
  console.log('OPEN:', opened)
  await sleep(1200)

  // 2) 新建表格（选关键指标表模板 + 绑定第一家企业）
  const created = await win.webContents.executeJavaScript(`
    (async () => {
      const byText = (sel, t) => [...document.querySelectorAll(sel)].find((x) => (x.innerText || '').includes(t))
      const add = byText('button', '新建表格')
      if (!add) return 'no-create-button'
      add.click()
      await new Promise((r) => setTimeout(r, 400))
      const card = document.querySelector('.modal-card')
      // 绑定企业：选第一个真实企业（未绑定会导致 NO_ENTERPRISE，无法入库）
      const selects = [...card.querySelectorAll('select')]
      const entSel = selects[1]
      const opts = [...entSel.options]
      const opt = opts.find((o) => {
        const t = (o.textContent || '').trim()
        return t && t !== '未绑定'
      })
      const optionDump = opts.map((o) => JSON.stringify({ v: o.value, t: o.textContent.trim() })).join(', ')
      if (opt) {
        entSel.value = opt.value
        entSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await new Promise((r) => setTimeout(r, 200))
      const confirm = [...card.querySelectorAll('button')].find((b) => b.innerText.trim() === '创建')
      if (!confirm) return 'no-confirm-button'
      confirm.click()
      await new Promise((r) => setTimeout(r, 2200))
      return 'created:' + (opt ? opt.textContent.trim() : 'no-enterprise') + ' | opts=' + optionDump
    })()
  `)
  console.log('CREATE:', created)
  await sleep(1500)

  // 3) 录入一个会破坏勾稽的值：资产 1000、负债 100、权益留空 → 应出现提示；再故意写错权益 → 错误
  const edited = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const grid = document.querySelector('table.grid')
      if (!grid) return 'no-grid'
      const rows = [...grid.querySelectorAll('tbody tr')]
      const labelOf = (tr) => (tr.querySelector('th input')?.value || '').trim()
      const findRow = (kw) => rows.find((tr) => labelOf(tr).includes(kw))
      const setCell = async (tr, value) => {
        const td = tr.querySelector('td.cell')
        if (!td) return false
        td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        td.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await wait(200)
        const input = td.querySelector('input.cell-input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(700)
        return true
      }
      const assets = findRow('资产总计')
      const liab = findRow('负债合计')
      const equity = findRow('所有者权益')
      if (!assets || !liab || !equity) {
        return 'missing-rows: ' + rows.map(labelOf).join(' | ')
      }
      await setCell(assets, 1000)
      await setCell(liab, 100)
      await setCell(equity, 500)   // 1000 ≠ 100 + 500 → 应报 BALANCE_MISMATCH
      await wait(1200)
      return 'edited'
    })()
  `)
  console.log('EDIT:', edited)
  await sleep(1500)

  const info = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.textContent || ''
      const grid = document.querySelector('table.grid')
      return {
        hasPanel: t.includes('财报表格'),
        hasGrid: !!grid,
        gridRows: grid ? grid.querySelectorAll('tbody tr').length : 0,
        gridCols: grid ? grid.querySelectorAll('thead th').length : 0,
        bannerShown: t.includes('勾稽校验通过') || t.includes('校验未通过'),
        bannerFail: t.includes('校验未通过'),
        mentionsBalance: t.includes('资产总计') && t.includes('负债'),
        cellValues: grid
          ? [...grid.querySelectorAll('tbody tr')].slice(0, 6).map((tr) => ({
              label: (tr.querySelector('th input')?.value || '').trim(),
              first: (tr.querySelector('td.cell')?.innerText || '').trim(),
            }))
          : [],
        textLen: t.length,
      }
    })()
  `)
  console.log('INFO:', JSON.stringify(info, null, 1))

  // 4) 修正权益 → 校验通过 → 入库
  const ingested = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const grid = document.querySelector('table.grid')
      const rows = [...grid.querySelectorAll('tbody tr')]
      const labelOf = (tr) => (tr.querySelector('th input')?.value || '').trim()
      const equity = rows.find((tr) => labelOf(tr).includes('所有者权益'))
      const td = equity.querySelector('td.cell')
      td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      td.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await wait(200)
      const input = td.querySelector('input.cell-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '900')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(1500)
      const passed = (document.body.textContent || '').includes('勾稽校验通过')
      const openBtn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('入库…'))
      if (!openBtn) return { passed, error: 'no-ingest-button' }
      openBtn.click()
      await wait(600)
      const confirm = [...document.querySelectorAll('.modal-card button')].find((b) => (b.innerText || '').trim() === '确认入库')
      if (!confirm) return { passed, error: 'no-confirm' }
      confirm.click()
      await wait(2500)
      const t = document.body.textContent || ''
      return {
        passed,
        ingested: t.includes('已入库'),
        note: (t.match(/新增 \\d+ 期[^\\n]*/) || [''])[0],
      }
    })()
  `)
  console.log('INGEST:', JSON.stringify(ingested, null, 1))
  await sleep(800)

  const final = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.textContent || ''
      const badges = [...document.querySelectorAll('.badge')].map((b) => (b.innerText || '').trim())
      const head = (document.querySelector('.page-head')?.textContent || '').replace(/\\n/g, ' / ')
      return {
        statusIngested: t.includes('已入库'),
        badges,
        head,
        conflictMentioned: t.includes('冲突') || t.includes('跳过'),
        textLen: t.length,
      }
    })()
  `)
  console.log('FINAL:', JSON.stringify(final, null, 1))
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 20), null, 1))
  app.quit()
})

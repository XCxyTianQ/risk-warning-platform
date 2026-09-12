/**
 * 表格「Excel 功能」冒烟：公式、区域选择、填充、插入/删除行列、排序、撤销/重做。
 * 另验证：对话输入框旁的 ＋ 上传按钮菜单、侧边栏表格入口。
 *
 * 用法：desktop\node_modules\electron\dist\electron.exe desktop\scripts\smoke-excel.js
 * 前置：SMOKE_URL 指向可用后端（无需模型）
 *
 * 说明：每个步骤都包了超时与异常处理，失败会打印而不是挂死；脚本结束自行退出。
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8259/'
const TSV = [
  '科目\t2025年报\t2024年报',
  '营业总收入\t128600\t96300',
  '营业成本\t78900\t60100',
  '资产总计\t356800\t301000',
  '负债合计\t176700\t138460',
  '所有者权益合计\t180100\t162540',
  '资产负债率\t49.52\t46.00',
].join('\n')

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
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`LOAD-FAIL ${code} ${desc}`)
    errors.push(`did-fail-load ${code} ${desc}`)
  })

  const evalJs = (code, timeout) => guard('JS', () => win.webContents.executeJavaScript(code), timeout)

  try {
    await win.loadURL(URL)
  } catch (e) {
    console.log('LOAD-THREW ' + String(e))
    app.quit()
    return
  }
  await sleep(3000)

  // ---------- 0) 页面与入口 ----------
  await guard('PING', () =>
    win.webContents.executeJavaScript(
      `({
        title: document.title,
        composer: !!document.querySelector('.composer'),
        rail: [...document.querySelectorAll('button.rail-btn')].map((b) => (b.getAttribute('title') || '').split(' —')[0]),
      })`,
    ),
  )

  await guard('ENTRY', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const rail = [...document.querySelectorAll('button.rail-btn')]
        const tableBtn = rail.find((x) => (x.getAttribute('title') || '').includes('财报表格'))
        const plus = [...document.querySelectorAll('.composer button')].find((b) => (b.textContent || '').trim() === '＋')
        const out = { railHasTables: !!tableBtn, plusButton: !!plus, menu: [] }
        if (plus) {
          plus.click()
          await wait(120)   // 等 Vue 渲染出菜单
          out.menu = [...document.querySelectorAll('.attach-menu button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim())
          plus.click()
        }
        return out
      })()`,
    ),
  )

  // ---------- 1) 打开面板 + 粘贴 TSV 建表 ----------
  await guard(
    'IMPORT',
    () =>
      win.webContents.executeJavaScript(
        `(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const rail = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
          if (!rail) return { error: 'no-rail-button' }
          rail.click()
          await wait(1000)
          const open = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('导入文件 / 粘贴'))
          if (!open) return { error: 'no-import-button' }
          open.click()
          await wait(400)
          const card = document.querySelector('.modal-card.wide')
          if (!card) return { error: 'no-modal' }
          const ta = card.querySelector('textarea.paste-box')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(ta, ${JSON.stringify(TSV)})
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          const entSel = card.querySelectorAll('select')[0]
          const opt = [...entSel.options].find((o) => (o.textContent || '').trim() !== '未绑定')
          if (opt) { entSel.value = opt.value; entSel.dispatchEvent(new Event('change', { bubbles: true })) }
          await wait(350)   // 等 Vue 把「解析并建表」从 disabled 状态刷新出来
          const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('解析并建表'))
          if (!btn) return { error: 'no-parse-button' }
          if (btn.disabled) return { error: 'parse-button-disabled', text: ta.value.slice(0, 40) }
          btn.click()
          await wait(3000)
          const grid = document.querySelector('.sheet table.grid')
          const errBox = document.querySelector('.error-box')
          return {
            grid: !!grid,
            rows: grid ? grid.querySelectorAll('tbody tr').length : 0,
            cols: grid ? grid.querySelectorAll('thead th').length : 0,
            error: errBox ? (errBox.textContent || '').trim().slice(0, 160) : '',
          }
        })()`,
      ),
    60000,
  )

  // ---------- 2) 公式 =B6/B4*100 ----------
  await guard('FORMULA', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const grid = document.querySelector('.sheet table.grid')
        if (!grid) return { error: 'no-grid' }
        const rows = [...grid.querySelectorAll('tbody tr')]
        const idx = (kw) => rows.findIndex((tr) => (tr.querySelector('th input')?.value || '').trim().includes(kw))
        const debt = idx('负债合计'), assets = idx('资产总计'), dr = idx('资产负债率')
        if (debt < 0 || assets < 0 || dr < 0) return { error: 'row-not-found', debt, assets, dr }
        const cell = rows[dr].querySelectorAll('td.cell')[0]
        cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await wait(250)
        const input = cell.querySelector('input.cell-input')
        if (!input) return { error: 'no-editor' }
        const formula = '=B' + (debt + 2) + '/B' + (assets + 2) + '*100'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, formula)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(150)
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
        await wait(900)
        let committedBy = 'Enter'
        if (document.querySelector('.sheet input.cell-input')) {
          // 合成按键/焦点在隐藏窗口里可能不生效：改用 change 事件（真实浏览器在回车或失焦时都会触发）
          committedBy = 'change'
          document.querySelector('.sheet input.cell-input').dispatchEvent(new Event('change', { bubbles: true }))
          await wait(1200)
        }
        // 重新查询 DOM（避免拿到编辑态节点）：读取 .cell-text 而不是 td.textContent（后者在输入框挂载时为空）
        const fresh = [...document.querySelectorAll('.sheet table.grid tbody tr')]
        const td = fresh[dr].querySelectorAll('td.cell')[0]
        const span = td.querySelector('.cell-text')
        return {
          formula,
          committedBy,
          value: span ? (span.textContent || '').trim() : td.querySelector('input') ? 'EDITING' : '',
          hasFx: !!td.querySelector('.fx'),
        }
      })()`,
    ),
  )

  // ---------- 3) 区域选择 + Ctrl+D 向下填充 ----------
  await guard('FILL', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const sheet = document.querySelector('.sheet')
        const grid = sheet.querySelector('table.grid')
        const rows = [...grid.querySelectorAll('tbody tr')]
        const r0 = rows.findIndex((tr) => (tr.querySelector('th input')?.value || '').includes('营业总收入'))
        if (r0 < 0) return { error: 'no-row' }
        const a = rows[r0].querySelectorAll('td.cell')[1]
        const b = rows[r0 + 1].querySelectorAll('td.cell')[1]
        a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        sheet.focus()
        sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
        await wait(1500)
        const fresh = [...grid.querySelectorAll('tbody tr')]
        const src = (fresh[r0].querySelectorAll('td.cell')[1].textContent || '').trim()
        const dst = (fresh[r0 + 1].querySelectorAll('td.cell')[1].textContent || '').trim()
        return { source: src, filledInto: dst, filled: src !== '' && src === dst }
      })()`,
    ),
  )

  // ---------- 4) 插入/删除行、撤销/重做、排序 ----------
  await guard('OPS', () =>
    win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const rowsNow = () => [...document.querySelectorAll('.sheet table.grid tbody tr')]
        const btn = (t) => [...document.querySelectorAll('.toolbar button')].find((b) => (b.textContent || '').trim() === t)
        const out = {}
        out.rowsBefore = rowsNow().length
        const target = rowsNow()[1]
        target.querySelector('th').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        target.querySelector('th').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        await wait(250)
        if (!btn('插入行')) return { error: 'no-insert-button', toolbar: [...document.querySelectorAll('.toolbar button')].map((b) => (b.textContent || '').trim()) }
        btn('插入行').click()
        await wait(1800)
        out.afterInsert = rowsNow().length
        btn('删除行').click()
        await wait(1800)
        out.afterDelete = rowsNow().length
        const buttons = [...document.querySelectorAll('.toolbar button')]
        buttons[0].click()
        await wait(1800)
        out.afterUndo = rowsNow().length
        buttons[1].click()
        await wait(1800)
        out.afterRedo = rowsNow().length
        const first = rowsNow()[0]
        first.querySelectorAll('td.cell')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        first.querySelectorAll('td.cell')[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        await wait(200)
        if (btn('↑ 排序')) btn('↑ 排序').click()
        await wait(1800)
        out.labelsAfterSort = rowsNow().map((tr) => (tr.querySelector('th input')?.value || '').trim()).slice(0, 5)
        return out
      })()`,
    ),
  )

  console.log('SUMMARY:', JSON.stringify({ results, errors: errors.slice(0, 10) }, null, 1))
  app.quit()
})

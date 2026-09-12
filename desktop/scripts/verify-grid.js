/**
 * 验收两件事（真实输入事件，不是模拟 .click()）：
 *   1) 表格工作区是否够大（测量 .sheet / .grid-wrap / 容器的实际高度）
 *   2) 双击、以及"再点一次已选中单元格"是否都能进入编辑；点编辑框内部不能把自己关掉；
 *      直接打字能否进入编辑并接在后面（123 而不是 3）；回车提交后是否写回单元格。
 * 用法：electron.exe desktop/scripts/verify-grid.js
 *   SMOKE_URL 默认 http://127.0.0.1:8265/
 *   SMOKE_BUDGET_MS 默认 90000（脚本自己超时退出，避免挂住）
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8265/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (label, value) => console.log(label + ':', typeof value === 'string' ? value : JSON.stringify(value))

const BUDGET = Number(process.env.SMOKE_BUDGET_MS || 90000)
setTimeout(() => {
  console.log('RESULT: timeout-after-' + BUDGET + 'ms')
  app.exit(2)
}, BUDGET)

const measure = `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const scroller = document.querySelector('.zone-maxed .zone-body') || document.querySelector('.zone-body')
  const sheets = [...document.querySelectorAll('.sheet')]
  return {
    win: { w: window.innerWidth, h: window.innerHeight },
    maximized: !!document.querySelector('.zone-maxed'),
    sheetCount: sheets.length,
    sheet: box(document.querySelector('.zone-maxed .sheet') || sheets[0]),
    gridWrap: box(document.querySelector('.zone-maxed .grid-wrap') || document.querySelector('.grid-wrap')),
    scroller: scroller ? scroller.className : null,
    scrollInfo: scroller ? { clientH: scroller.clientHeight, scrollH: scroller.scrollHeight } : null,
    rows: document.querySelectorAll('.sheet table.grid tbody tr').length
  }
})()`

const pickCell = (index) => `(() => {
  const root = document.querySelector('.zone-maxed') || document
  const sheet = root.querySelector('.sheet')
  if (!sheet) return null
  sheet.scrollTop = 0
  const cells = [...sheet.querySelectorAll('table.grid tbody td.cell')]
  const usable = []
  for (const td of cells) {
    const r = td.getBoundingClientRect()
    if (r.width < 40 || r.height < 12) continue
    const x = Math.round(r.left + Math.min(24, r.width / 2))
    const y = Math.round(r.top + r.height / 2)
    if (y < 60 || y > window.innerHeight - 60) continue
    const hit = document.elementFromPoint(x, y)
    if (hit === td || (hit && hit.closest && hit.closest('td.cell') === td)) {
      usable.push({ x: x, y: y, rowIdx: [...td.parentElement.parentElement.children].indexOf(td.parentElement),
                    colIdx: [...td.parentElement.children].indexOf(td) })
    }
  }
  return usable[${index}] || null
})()`

const editorState = `(() => {
  const root = document.querySelector('.zone-maxed') || document
  const input = root.querySelector('.sheet input.cell-input')
  return { editorShown: !!input, value: input ? input.value : null,
           focused: document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '') : '' }
})()`

const markSheet = `(() => { const s = document.querySelector('.zone-maxed .sheet'); if (s) s.setAttribute('data-probe', '1'); return !!s })()`
const sameSheet = `(() => ({ sameSheet: !!document.querySelector('.zone-maxed .sheet[data-probe]') }))()`

app.on('ready', async () => {
  const win = new BrowserWindow({ show: true, width: 1600, height: 950 })
  const errors = []
  win.webContents.on('console-message', (...args) => {
    const d = args[0]
    if (d && typeof d === 'object' && typeof d.message === 'string' && d.level === 'error') {
      errors.push('[error] ' + d.message)
    }
  })
  await win.loadURL(URL)
  await sleep(3000)

  // 每一步都带超时：卡住的那一步要能被看见，而不是挂住整个测试
  const rawEval = (code) => win.webContents['executeJavaScript'](code)
  const evalJs = async (code) => {
    try {
      const out = await Promise.race([rawEval(code), sleep(12000).then(() => '__STEP_TIMEOUT__')])
      if (out === '__STEP_TIMEOUT__') console.log('STEP_TIMEOUT:', String(code).slice(0, 60).replace(/\s+/g, ' '))
      return out
    } catch (e) {
      console.log('STEP_ERROR:', String((e && e.message) || e).slice(0, 200))
      return null
    }
  }

  const send = (type, x, y, clickCount = 1) =>
    win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount, modifiers: [] })
  const realClick = async (x, y) => {
    send('mouseMove', x, y, 0)
    await sleep(60)
    send('mouseDown', x, y, 1)
    await sleep(70)
    send('mouseUp', x, y, 1)
    await sleep(220)
  }
  const realDblClick = async (x, y) => {
    send('mouseMove', x, y, 0)
    await sleep(60)
    send('mouseDown', x, y, 1)
    await sleep(70)
    send('mouseUp', x, y, 1)
    await sleep(80)
    send('mouseDown', x, y, 2)
    await sleep(70)
    send('mouseUp', x, y, 2)
    await sleep(400)
  }
  const key = async (keyCode) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(220)
  }

  // 打开表格面板 → 新建空白表
  const opened = await evalJs(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const rail = [...document.querySelectorAll('button.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('财报表格'))
      if (!rail) return 'no-rail'
      rail.click(); await wait(1000)
      const add = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('新建表格'))
      if (!add) return 'no-new-button'
      add.click(); await wait(500)
      const card = document.querySelector('.modal-card')
      if (!card) return 'no-modal'
      const create = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '创建')
      if (!create) return 'no-create'
      create.click(); await wait(2600)
      return document.querySelector('.sheet table.grid') ? 'ok' : 'no-grid'
    })()
  `)
  log('OPEN', opened)
  await sleep(400)

  log('MARK', await evalJs(markSheet))
  log('GEOMETRY', await evalJs(measure))

  // ---- 1. 双击进入编辑 ----
  const c0 = await evalJs(pickCell(0))
  log('CELL0', c0)
  if (!c0) {
    log('RESULT', 'no-clickable-cell')
    log('ERRORS', errors.slice(0, 8))
    app.exit(1)
    return
  }
  await realDblClick(c0.x, c0.y)
  log('AFTER_DBLCLICK', await evalJs(editorState))
  log('SHEET_IDENTITY', await evalJs(sameSheet))

  // 点编辑框内部：不能把自己关掉
  await realClick(c0.x, c0.y)
  log('AFTER_CLICK_INSIDE_EDITOR', await evalJs(editorState))
  await key('Escape')
  log('AFTER_ESCAPE', await evalJs(editorState))

  // ---- 2. 单击"未选中"的单元格只选中；再点一次才进入编辑 ----
  const c1 = await evalJs(pickCell(12))
  log('CELL1', c1)
  if (c1) {
    await realClick(c1.x, c1.y)
    log('AFTER_FIRST_CLICK', await evalJs(editorState))
    await realClick(c1.x, c1.y)
    log('AFTER_SECOND_CLICK', await evalJs(editorState))
    await key('Escape')
  }

  // ---- 3. 直接打字（keyDown 才是真实按键序列）+ 回车提交 ----
  const c2 = await evalJs(pickCell(13))
  log('CELL2', c2)
  if (c2) {
    await realClick(c2.x, c2.y)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1' })
    await sleep(150)
    for (const ch of ['2', '3']) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(90)
    }
    await sleep(220)
    log('AFTER_TYPING', await evalJs(editorState))
    await key('Return')
    await sleep(1500)
    log('AFTER_COMMIT', await evalJs(`
      (() => {
        const root = document.querySelector('.zone-maxed') || document
        const tr = root.querySelectorAll('.sheet table.grid tbody tr')[${c2.rowIdx}]
        const td = tr ? tr.children[${c2.colIdx}] : null
        return { cellText: td ? (td.querySelector('.cell-text') || td).textContent.trim() : null,
                 stillEditing: !!root.querySelector('.sheet input.cell-input') }
      })()
    `))
  }

  // ---- 4. 拖拽选区（从已选中单元格开始拖，不能误进编辑）----
  const c3 = await evalJs(pickCell(3))
  if (c3) {
    await realClick(c3.x, c3.y)
    send('mouseMove', c3.x, c3.y, 0)
    send('mouseDown', c3.x, c3.y, 1)
    await sleep(70)
    const c4 = await evalJs(pickCell(5))
    if (c4) {
      send('mouseMove', c4.x, c4.y, 0)
      await sleep(80)
      win.webContents.sendInputEvent({ type: 'mouseUp', x: c4.x, y: c4.y, button: 'left', clickCount: 1 })
      await sleep(300)
      log('AFTER_DRAG', await evalJs(`
        (() => { const root = document.querySelector('.zone-maxed') || document
          return { editorShown: !!root.querySelector('.sheet input.cell-input'),
                   selCount: root.querySelectorAll('.sheet td.sel, .sheet th.sel').length } })()
      `))
    }
  }

  // ---- 5. 还原成停靠态也要够用（不能只有最大化才像样）----
  const restored = await evalJs(`
    (() => {
      const btn = [...document.querySelectorAll('.zone-maxed .maxed-head button')][0]
      if (!btn) return 'no-restore'
      btn.click()
      return 'clicked'
    })()
  `)
  await sleep(900)
  log('RESTORE', restored)
  log('DOCKED', await evalJs(`
    (() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) } }
      const body = document.querySelector('.zone-body')
      const sheet = document.querySelector('.zone-body .sheet')
      const wrap = document.querySelector('.zone-body .grid-wrap')
      return { maximized: !!document.querySelector('.zone-maxed'), sheetCount: document.querySelectorAll('.sheet').length,
               body: box(body), wrap: box(wrap), sheet: box(sheet),
               toolbarRows: (() => { const t = document.querySelector('.zone-body .card.toolbar'); return t ? Math.round(t.getBoundingClientRect().height) : null })() }
    })()
  `))

  log('GEOMETRY_AFTER', await evalJs(measure))
  log('ERRORS', errors.slice(0, 8))
  app.exit(0)
})

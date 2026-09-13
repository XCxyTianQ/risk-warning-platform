/**
 * 财报表格面板冒烟：新建（关键指标表模板）→ 录入单元格 → 勾稽校验（先不通过）→ 修正 → 入库。
 *
 * 用法：electron.exe desktop/scripts/smoke-tables.js
 * 前置：SMOKE_URL 指向可用后端（后端同时托管前端构建产物）
 *
 * 说明：v0.7 起「新建表格」默认是**空白表格**，所以这里显式选 kpi 模板，
 *       才能拿到"资产总计/负债合计/所有者权益"这些科目行做勾稽验证。
 * 每一步都有超时：脚本必须能自己结束，绝不能把评测挂住。
 */
const { app, BrowserWindow } = require('electron')

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8252/'
const TEMPLATE = process.env.SMOKE_TEMPLATE || 'kpi'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BUDGET = Number(process.env.SMOKE_BUDGET_MS || 240000)

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
  const evalJs = async (label, code, timeoutMs = 30000) => {
    const out = await Promise.race([rawEval(code), sleep(timeoutMs).then(() => '__STEP_TIMEOUT__')])
    if (out === '__STEP_TIMEOUT__') {
      console.log('STEP_TIMEOUT:', label)
      errors.push(`STEP_TIMEOUT ${label}`)
    }
    return out
  }

  // 单元格赋值：真实事件序列（mousedown → mouseup → dblclick）进入编辑，再逐字输入
  const setCellScript = (rowKeyword, value) => `
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const grid = document.querySelector('table.grid')
      if (!grid) return 'no-grid'
      const rows = [...grid.querySelectorAll('tbody tr')]
      const labelOf = (tr) => (tr.querySelector('th input')?.value || tr.querySelector('th')?.innerText || '').trim()
      const tr = rows.find((x) => labelOf(x).includes(${JSON.stringify(rowKeyword)}))
      if (!tr) return 'missing-row:' + ${JSON.stringify(rowKeyword)}
      const td = tr.querySelector('td.cell')
      if (!td) return 'no-cell'
      const opts = { bubbles: true, clientX: 1, clientY: 1 }
      td.dispatchEvent(new MouseEvent('mousedown', opts))
      td.dispatchEvent(new MouseEvent('mouseup', opts))
      await wait(80)
      td.dispatchEvent(new MouseEvent('mousedown', { ...opts, detail: 2 }))
      td.dispatchEvent(new MouseEvent('mouseup', { ...opts, detail: 2 }))
      td.dispatchEvent(new MouseEvent('dblclick', opts))
      await wait(250)
      const input = td.querySelector('input.cell-input')
      if (!input) return 'no-editor'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(${JSON.stringify(String(value))}))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(600)
      return 'ok'
    })()
  `

  try {
    await win.loadURL(URL)
    await sleep(3500)

    // 1) 打开面板
    const opened = await evalJs(
      'open-panel',
      `(() => {
        const btns = [...document.querySelectorAll('button.rail-btn')]
        const b = btns.find((x) => (x.getAttribute('title') || '').includes('财报表格'))
        if (!b) return 'no-button'
        b.click()
        return 'clicked'
      })()`,
    )
    console.log('OPEN:', opened)
    await sleep(1200)

    // 2) 新建：显式选模板 + 绑定第一家企业
    const created = await evalJs(
      'create',
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const add = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('新建表格'))
        if (!add) return 'no-create-button'
        add.click()
        await wait(500)
        const card = document.querySelector('.modal-card')
        if (!card) return 'no-modal'
        const selects = [...card.querySelectorAll('select')]
        const kindSel = selects[0]
        const entSel = selects[1]
        const kindOpt = [...(kindSel?.options || [])].find((o) => o.value === ${JSON.stringify(TEMPLATE)})
        if (!kindOpt) return 'no-template-option:' + [...(kindSel?.options || [])].map((o) => o.value).join(',')
        kindSel.value = kindOpt.value
        kindSel.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(250)
        const entOpt = [...(entSel?.options || [])].find((o) => (o.textContent || '').trim() && o.textContent.trim() !== '未绑定')
        if (entOpt) {
          entSel.value = entOpt.value
          entSel.dispatchEvent(new Event('change', { bubbles: true }))
        }
        await wait(250)
        const confirm = [...card.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '创建')
        if (!confirm) return 'no-confirm-button'
        confirm.click()
        await wait(2600)
        return document.querySelector('table.grid') ? 'ok' : 'no-grid-after-create'
      })()`,
    )
    console.log('CREATE:', created)
    await sleep(800)

    // 3) 写入会破坏勾稽的值：资产 1000、负债 100、权益 500（1000 ≠ 100+500）
    const editResults = []
    for (const [label, value] of [
      ['资产总计', 1000],
      ['负债合计', 100],
      ['所有者权益', 500],
    ]) {
      editResults.push(`${label}=${await evalJs(`set-${label}`, setCellScript(label, value))}`)
    }
    console.log('EDIT:', editResults.join(' '))
    await sleep(1500)

    const banner = await evalJs(
      'banner-check',
      `(() => {
        const t = document.body.textContent || ''
        return {
          hasGrid: !!document.querySelector('table.grid'),
          rows: document.querySelectorAll('table.grid tbody tr').length,
          bannerShown: t.includes('勾稽校验通过') || t.includes('校验未通过'),
          bannerFail: t.includes('校验未通过'),
        }
      })()`,
    )
    console.log('BANNER:', JSON.stringify(banner))

    // 4) 修正权益 → 校验通过 → 入库
    const fixed = await evalJs('fix-equity', setCellScript('所有者权益', 900))
    await sleep(1800)
    const ingested = await evalJs(
      'ingest',
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const passed = (document.body.textContent || '').includes('勾稽校验通过')
        const openBtn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('入库…'))
        if (!openBtn) return { passed, error: 'no-ingest-button' }
        openBtn.click()
        await wait(700)
        const confirm = [...document.querySelectorAll('.modal-card button')].find((b) => (b.innerText || '').trim() === '确认入库')
        if (!confirm) return { passed, error: 'no-confirm' }
        confirm.click()
        await wait(2600)
        const t = document.body.textContent || ''
        return { passed, ingested: t.includes('已入库') || t.includes('新增'), note: (t.match(/新增 \\d+ 期[^\\n]*/) || [''])[0] }
      })()`,
      40000,
    )
    console.log('INGEST:', JSON.stringify(ingested))

    const summary = {
      template: TEMPLATE,
      opened,
      created,
      edited: editResults,
      banner,
      fixed,
      ingested,
      errors: errors.slice(0, 10),
    }
    console.log('SUMMARY:', JSON.stringify(summary, null, 1))

    const ok =
      opened === 'clicked' &&
      created === 'ok' &&
      banner?.hasGrid === true &&
      banner?.bannerFail === true &&
      fixed === 'ok' &&
      ingested?.passed === true &&
      ingested?.ingested === true &&
      errors.length === 0
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.log('FATAL:', String((err && err.stack) || err))
    console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)))
    app.exit(1)
  }
})

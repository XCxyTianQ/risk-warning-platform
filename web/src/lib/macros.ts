/**
 * 表格宏：用一小段 JS 对当前工作表做批量处理（Excel 宏的轻量替代）。
 *
 * 定位与边界（诚实说明）：
 *  - 支持**脚本宏**：宏代码拿到 columns/rows，可以增删行列、改值、算合计，适合"每次都要手工重复"的整理工作；
 *  - 不支持 VBA 语法与 Excel 对象模型（那是 Windows 专属生态），也不做宏录制；
 *  - 宏随表格保存（table_doc.macro_json），在本机浏览器里执行，运行前会保存快照以便撤销。
 *
 * 宏里可用的 API（ctx）：
 *   sheet.columns / sheet.rows      当前工作表（可直接改）
 *   num(v)                          把任意单元格值转成数字（容错千分位/百分号/括号负数）
 *   cell(rowLabel, colLabel)        按标题取单元格值
 *   set(rowLabel, colLabel, value)  按标题写单元格（标题不存在时自动建行/建列）
 *   addColumn(label) / addRow(label) 新增列 / 行，返回其 key
 *   colValues(colLabel)             整列数值数组
 *   log(...)                        输出到运行日志
 */

export interface MacroSheetColumn {
  key: string
  label: string
  period?: string
  report_type?: string
  type?: string
}
export interface MacroSheetRow {
  key: string
  label: string
  field?: string
  cells: Record<string, any>
}
export interface MacroSheet {
  columns: MacroSheetColumn[]
  rows: MacroSheetRow[]
}

export interface Macro {
  name: string
  code: string
  updated_at?: string
  builtin?: boolean
}

export interface MacroResult {
  sheet: MacroSheet
  logs: string[]
  error?: string
  changed: number
}

export const num = (v: any): number => {
  if (typeof v === 'number') return v
  if (v === null || v === undefined) return 0
  const t = String(v).trim()
  if (t === '') return 0
  const neg = /^\((.*)\)$/.exec(t)
  const body = t.replace(/[,，\s%]/g, '')
  const n = Number(neg ? `-${neg[1]}` : body)
  return Number.isFinite(n) ? n : 0
}

/** 执行宏：传入当前工作表，返回处理后的工作表 */
export function runMacro(code: string, source: MacroSheet): MacroResult {
  const sheet: MacroSheet = JSON.parse(JSON.stringify(source))
  const logs: string[] = []
  let changed = 0
  const log = (...args: any[]) => logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))

  const findCol = (label: string) =>
    sheet.columns.find((c) => (c.label || '').trim() === String(label).trim() || c.key === label)
  const findRow = (label: string) => sheet.rows.find((r) => (r.label || '').trim() === String(label).trim())

  const addColumn = (label: string): string => {
    const key = `m_${Date.now().toString(36)}_${sheet.columns.length}`
    sheet.columns.push({ key, label: String(label), period: '', report_type: '', type: 'number' })
    return key
  }
  const addRow = (label: string): string => {
    const key = `mr_${Date.now().toString(36)}_${sheet.rows.length}`
    sheet.rows.push({ key, label: String(label), field: '', cells: {} })
    return key
  }
  const cell = (rowLabel: string, colLabel: string): any => {
    const r = findRow(rowLabel)
    const c = findCol(colLabel)
    if (!r || !c) return null
    return r.cells?.[c.key]?.value ?? null
  }
  const set = (rowLabel: string, colLabel: string, value: any, opts: { formula?: string } = {}) => {
    let r = findRow(rowLabel)
    if (!r) {
      addRow(rowLabel)
      r = findRow(rowLabel)!
    }
    let c = findCol(colLabel)
    if (!c) {
      const key = addColumn(colLabel)
      c = findCol(key)!
    }
    r.cells = r.cells ?? {}
    r.cells[c.key] = { value, source: 'macro', confidence: 1, ...(opts.formula ? { formula: opts.formula } : {}) }
    changed += 1
  }
  const colValues = (colLabel: string): number[] => {
    const c = findCol(colLabel)
    if (!c) return []
    return sheet.rows.map((r) => r.cells?.[c.key]?.value).filter((v) => v !== null && v !== undefined).map(num)
  }

  try {
    // 宏正文：允许直接写语句（不再包一层函数返回）
    const fn = new Function('ctx', `"use strict";\nconst {sheet, num, cell, set, addColumn, addRow, colValues, log} = ctx;\n${code}\n`)
    fn({ sheet, num, cell, set, addColumn, addRow, colValues, log })
  } catch (e) {
    return { sheet: source, logs, error: (e as Error).message, changed: 0 }
  }
  return { sheet, logs, error: undefined, changed }
}

/** 内置宏模板（可直接运行，也可另存为新宏） */
export const BUILTIN_MACROS: Macro[] = [
  {
    name: '按行求和（新增「合计」列）',
    builtin: true,
    code: `// 把数值列逐行相加，写到「合计」列
const skip = ['合计', '占比', '比例']
const valueCols = sheet.columns.filter(c => !skip.some(s => (c.label || '').includes(s)))
sheet.rows.forEach(r => {
  const sum = valueCols.reduce((acc, c) => acc + num(r.cells?.[c.key]?.value), 0)
  set(r.label, '合计', Math.round(sum * 10000) / 10000)
})
log('已为', sheet.rows.length, '行计算合计')`,
  },
  {
    name: '单位换算：元 → 万元',
    builtin: true,
    code: `// 所有数值 ÷10000（把以「元」填的表统一成「万元」）
let n = 0
sheet.rows.forEach(r => {
  sheet.columns.forEach(c => {
    const cellObj = r.cells?.[c.key]
    if (cellObj && typeof cellObj.value === 'number') {
      cellObj.value = Math.round((cellObj.value / 10000) * 10000) / 10000
      n += 1
    }
  })
})
log('已换算', n, '个单元格')`,
  },
  {
    name: '删除空行',
    builtin: true,
    code: `// 去掉没有任何数值的行
const before = sheet.rows.length
sheet.rows = sheet.rows.filter(r => Object.values(r.cells || {}).some(c => c && c.value !== null && c.value !== undefined && c.value !== ''))
log('删除', before - sheet.rows.length, '行空行')`,
  },
  {
    name: '重算资产负债率（负债 ÷ 资产 ×100）',
    builtin: true,
    code: `// 需要表里有「资产总计」与「负债合计」两行；结果写到「资产负债率」行
sheet.columns.forEach(c => {
  const assets = num(cell('资产总计', c.label || c.key))
  const debt = num(cell('负债合计', c.label || c.key))
  const dr = num(cell('资产负债率', c.label || c.key))
  if (assets > 0 && (debt > 0 || dr > 0)) {
    set('资产负债率', c.label || c.key, Math.round((debt / assets) * 100 * 100) / 100)
  }
})
log('资产负债率已重算')`,
  },
  {
    name: '纵向汇总（追加合计行）',
    builtin: true,
    code: `// 在最下方追加一行「合计」，逐列求和
sheet.columns.forEach(c => {
  const total = sheet.rows.reduce((acc, r) => acc + num(r.cells?.[c.key]?.value), 0)
  if (total !== 0) set('合计', c.label || c.key, Math.round(total * 10000) / 10000)
})
log('已追加合计行')`,
  },
  {
    name: '按列取整（保留 2 位小数）',
    builtin: true,
    code: `let n = 0
sheet.rows.forEach(r => Object.values(r.cells || {}).forEach(c => {
  if (c && typeof c.value === 'number') { c.value = Math.round(c.value * 100) / 100; n += 1 }
}))
log('已取整', n, '个单元格')`,
  },
]

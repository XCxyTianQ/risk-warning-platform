/**
 * 数据透视表：把当前工作表当成一张"数据表"做分组汇总。
 *
 * 字段口径（与栅格一致）：A 列是行标题（字段名 `__label`），其余列按列 key 取值。
 * 典型用法：导入一张长表（年度 | 科目 | 数值），选
 *   行字段=科目、列字段=年度、值字段=数值、聚合=求和 → 得到「科目 × 年度」矩阵。
 */

export interface PivotColumn {
  key: string
  label: string
}
export interface PivotRow {
  key: string
  label: string
  cells: Record<string, { value?: number | string | null } | undefined>
}
export interface PivotSheet {
  columns: PivotColumn[]
  rows: PivotRow[]
}

export type Agg = 'sum' | 'count' | 'avg' | 'max' | 'min'

export interface PivotSpec {
  rowField: string
  colField: string
  valueField: string
  agg: Agg
}

export interface PivotField {
  key: string
  label: string
  numeric: boolean
}

/** 可作为透视字段的列（含行标题列） */
export function pivotFields(sheet: PivotSheet): PivotField[] {
  void sheet
  const fields: PivotField[] = [{ key: '__label', label: '行标题（A 列）', numeric: false }]
  for (const c of sheet.columns) {
    fields.push({ key: c.key, label: c.label || c.key, numeric: true })
  }
  return fields
}

function cellRaw(sheet: PivotSheet, row: PivotRow, field: string): string {
  void sheet
  if (field === '__label') return String(row.label ?? '')
  const v = row.cells?.[field]?.value
  if (v === null || v === undefined) return ''
  return String(v)
}

/** 数值解析：容忍千分位、百分号、括号负数 */
export function toNum(raw: string): number | null {
  const t = String(raw ?? '').trim()
  if (t === '' || t === '-' || t === '—') return null
  const pct = t.endsWith('%')
  const body = t.replace(/[,，\s%]/g, '')
  const neg = /^\((.*)\)$/.exec(body)
  const n = Number(neg ? `-${neg[1]}` : body)
  if (!Number.isFinite(n)) return null
  return pct ? n / 100 : n
}

export interface PivotResult {
  rowLabels: string[]
  colLabels: string[]
  matrix: (number | null)[][]
  counts: number[][]
  total: number | null
  scannedRows: number
  warnings: string[]
}

export function pivot(sheet: PivotSheet, spec: PivotSpec): PivotResult {
  const warnings: string[] = []
  const rowLabels: string[] = []
  const colLabels: string[] = []
  const buckets = new Map<string, number[]>() // `${r}\u0000${c}` → 值列表

  for (const row of sheet.rows) {
    const rl = cellRaw(sheet, row, spec.rowField).trim()
    const cl = cellRaw(sheet, row, spec.colField).trim()
    if (rl === '' && cl === '') continue
    const rk = rl || '(空)'
    const ck = cl || '(空)'
    if (!rowLabels.includes(rk)) rowLabels.push(rk)
    if (!colLabels.includes(ck)) colLabels.push(ck)
    const raw = cellRaw(sheet, row, spec.valueField)
    const n = toNum(raw)
    const key = `${rk}\u0000${ck}`
    const list = buckets.get(key) ?? []
    if (n !== null) list.push(n)
    else if (raw.trim() !== '') warnings.push(`无法解析为数值：${raw.slice(0, 20)}`)
    buckets.set(key, list)
  }

  const agg = (list: number[]): number | null => {
    if (!list.length) return null
    switch (spec.agg) {
      case 'sum':
        return round(list.reduce((a, b) => a + b, 0))
      case 'count':
        return list.length
      case 'avg':
        return round(list.reduce((a, b) => a + b, 0) / list.length)
      case 'max':
        return Math.max(...list)
      case 'min':
        return Math.min(...list)
    }
  }

  const matrix: (number | null)[][] = []
  const counts: number[][] = []
  for (const r of rowLabels) {
    const line: (number | null)[] = []
    const lineCounts: number[] = []
    for (const c of colLabels) {
      const list = buckets.get(`${r}\u0000${c}`) ?? []
      line.push(agg(list))
      lineCounts.push(list.length)
    }
    matrix.push(line)
    counts.push(lineCounts)
  }
  const all = [...buckets.values()].flat()
  return {
    rowLabels,
    colLabels,
    matrix,
    counts,
    total: agg(all),
    scannedRows: sheet.rows.length,
    warnings: [...new Set(warnings)].slice(0, 5),
  }
}

const round = (v: number) => Math.round(v * 1e6) / 1e6

/** 把透视结果转成工作表（可插入为新 sheet） */
export function pivotToSheet(result: PivotResult, spec: PivotSpec, name: string): PivotSheet {
  const columns = [
    { key: 'p0', label: spec.rowField === '__label' ? '行标题' : '行', period: '', report_type: '', type: 'text' },
    ...result.colLabels.map((label, i) => ({
      key: `p${i + 1}`,
      label,
      period: '',
      report_type: '',
      type: 'number',
    })),
  ] as any[]
  const rows = result.rowLabels.map((label, ri) => {
    const cells: Record<string, any> = {}
    result.colLabels.forEach((_, ci) => {
      const v = result.matrix[ri]?.[ci]
      if (v !== null && v !== undefined) {
        cells[`p${ci + 1}`] = { value: v, source: 'pivot', confidence: 1 }
      }
    })
    return { key: `pr${ri + 1}`, label, field: '', cells }
  })
  return { columns, rows, meta: { pivotedFrom: name, spec } } as any
}

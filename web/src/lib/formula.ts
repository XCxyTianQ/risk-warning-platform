/**
 * 表格公式引擎（前端计算，兼容 Excel 常用语法）。
 *
 * 设计取舍：
 *  - **在前端算**：编辑体验要求即时反馈，且后端/引擎/Agent 只需要「最终数值」。
 *    计算后的值随 sheet 一起落库（单元格同时保存 formula 与 value），
 *    后端的勾稽校验、入库、金融分析读到的永远是数值，不需要理解公式。
 *  - **地址约定**：A 列 = 科目名，B.. 列 = 各期间；第 1 行是表头。
 *    与用户看到的表格完全一致，`=B3/B2*100` 就是「第 3 行 ÷ 第 2 行」。
 *  - 支持：算术 + - * / ^ %、比较 = <> < > <= >=、括号、单元格引用 A1、
 *    区域 A1:B3、区域函数 SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/MEDIAN、
 *    逻辑 IF/AND/OR/NOT、数学 ROUND/ROUNDUP/ROUNDDOWN/ABS/SQRT/POWER/LOG/LN/EXP/INT/MOD、
 *    文本 & 连接与 LEN/LEFT/RIGHT/MID/UPPER/LOWER/TRIM、错误值 #DIV/0! #VALUE! #REF! #NAME? #CYCLE!
 */

export type CellValue = number | string | null | FormulaError

export interface FormulaError {
  __error: string
}

export const isError = (v: unknown): v is FormulaError =>
  typeof v === 'object' && v !== null && '__error' in (v as any)

export function errText(v: unknown): string {
  return isError(v) ? (v as FormulaError).__error : String(v ?? '')
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'range'; a: string; b: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' }

const REF = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})/

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const s = src.trim().replace(/^=/, '')
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n') {
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let buf = ''
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') {
          buf += '"'
          j += 2
          continue
        }
        if (s[j] === '"') break
        buf += s[j]
        j++
      }
      out.push({ t: 'str', v: buf })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let j = i
      while (j < s.length && /[0-9._]/.test(s[j])) j++
      // 科学计数
      if (s[j] === 'e' || s[j] === 'E') {
        let k = j + 1
        if (s[k] === '+' || s[k] === '-') k++
        if (/[0-9]/.test(s[k] ?? '')) {
          while (k < s.length && /[0-9]/.test(s[k])) k++
          j = k
        }
      }
      out.push({ t: 'num', v: Number(s.slice(i, j).replace(/_/g, '')) })
      i = j
      continue
    }
    const rest = s.slice(i)
    const m = REF.exec(rest)
    if (m) {
      const first = `${m[1].toUpperCase()}${m[2]}`
      let j = i + m[0].length
      if (s[j] === ':') {
        const m2 = REF.exec(s.slice(j + 1))
        if (m2) {
          const second = `${m2[1].toUpperCase()}${m2[2]}`
          out.push({ t: 'range', a: first, b: second })
          i = j + 1 + m2[0].length
          continue
        }
      }
      out.push({ t: 'ref', v: first })
      i = j
      continue
    }
    if (/[A-Za-z_\u4e00-\u9fa5]/.test(c)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_.\u4e00-\u9fa5]/.test(s[j])) j++
      out.push({ t: 'name', v: s.slice(i, j).toUpperCase() })
      i = j
      continue
    }
    if (c === '(') {
      out.push({ t: 'lp' })
      i++
      continue
    }
    if (c === ')') {
      out.push({ t: 'rp' })
      i++
      continue
    }
    if (c === ',' || c === '，') {
      out.push({ t: 'comma' })
      i++
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two })
      i += 2
      continue
    }
    if ('+-*/^%&=<>'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`无法识别的字符：${c}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// 解析（递归下降）
// ---------------------------------------------------------------------------

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; v: string }
  | { k: 'range'; a: string; b: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'un'; op: string; e: Node }
  | { k: 'pct'; e: Node }

export function parse(src: string): Node {
  const tokens = tokenize(src)
  let p = 0
  const peek = () => tokens[p]
  const eat = () => tokens[p++]

  const parseExpr = (): Node => parseCompare()
  const parseCompare = (): Node => {
    let l = parseConcat()
    while (peek()?.t === 'op' && ['=', '!=', '<', '>', '<=', '>='].includes((peek() as any).v)) {
      const op = (eat() as any).v as string
      l = { k: 'bin', op, l, r: parseConcat() }
    }
    return l
  }
  const parseConcat = (): Node => {
    let l = parseAdd()
    while (peek()?.t === 'op' && (peek() as any).v === '&') {
      eat()
      l = { k: 'bin', op: '&', l, r: parseAdd() }
    }
    return l
  }
  const parseAdd = (): Node => {
    let l = parseMul()
    while (peek()?.t === 'op' && ['+', '-'].includes((peek() as any).v)) {
      const op = (eat() as any).v as string
      l = { k: 'bin', op, l, r: parseMul() }
    }
    return l
  }
  const parseMul = (): Node => {
    let l = parsePower()
    while (peek()?.t === 'op' && ['*', '/'].includes((peek() as any).v)) {
      const op = (eat() as any).v as string
      l = { k: 'bin', op, l, r: parsePower() }
    }
    return l
  }
  const parsePower = (): Node => {
    const l = parseUnary()
    if (peek()?.t === 'op' && (peek() as any).v === '^') {
      eat()
      return { k: 'bin', op: '^', l, r: parsePower() }
    }
    return l
  }
  const parseUnary = (): Node => {
    const t = peek()
    if (t?.t === 'op' && (t.v === '-' || t.v === '+')) {
      eat()
      const e = parseUnary()
      return t.v === '-' ? { k: 'un', op: '-', e } : e
    }
    return parsePostfix()
  }
  const parsePostfix = (): Node => {
    let e = parsePrimary()
    while (peek()?.t === 'op' && (peek() as any).v === '%') {
      eat()
      e = { k: 'pct', e }
    }
    return e
  }
  const parsePrimary = (): Node => {
    const t = eat()
    if (!t) throw new Error('公式意外结束')
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v }
      case 'str':
        return { k: 'str', v: t.v }
      case 'ref':
        return { k: 'ref', v: t.v }
      case 'range':
        return { k: 'range', a: t.a, b: t.b }
      case 'lp': {
        const e = parseExpr()
        if (peek()?.t !== 'rp') throw new Error('缺少右括号')
        eat()
        return e
      }
      case 'name': {
        if (peek()?.t === 'lp') {
          eat()
          const args: Node[] = []
          if (peek()?.t !== 'rp') {
            args.push(parseExpr())
            while (peek()?.t === 'comma') {
              eat()
              args.push(parseExpr())
            }
          }
          if (peek()?.t !== 'rp') throw new Error('函数缺少右括号')
          eat()
          return { k: 'call', name: t.v, args }
        }
        // 裸名字：TRUE/FALSE
        if (t.v === 'TRUE') return { k: 'num', v: 1 }
        if (t.v === 'FALSE') return { k: 'num', v: 0 }
        throw new Error(`未知名称：${t.v}`)
      }
      default:
        throw new Error('公式语法错误')
    }
  }
  const node = parseExpr()
  if (p < tokens.length) throw new Error('公式末尾有多余内容')
  return node
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

const colIndex = (letters: string): number => {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const colName = (idx: number): string => {
  let s = ''
  let n = idx + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export const addr = (colIdx: number, rowIdx: number): string => `${colName(colIdx)}${rowIdx + 1}`

export function parseAddr(a: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a.trim())
  if (!m) return null
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 }
}

/** 表格栅格：cell(r,c) → 原始值（数值或字符串） */
export interface Grid {
  cols: number
  rows: number
  get: (row: number, col: number) => CellValue
  /** 公式单元格获取（用于循环检测） */
  hasFormula?: (row: number, col: number) => boolean
}

const num = (v: CellValue): number => {
  if (typeof v === 'number') return v
  if (v === null || v === undefined || v === '') return 0
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

const toBool = (v: CellValue): boolean => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return String(v ?? '').length > 0
}

type Ctx = { grid: Grid; visiting: Set<string>; evaluateFormula: (row: number, col: number) => CellValue }

function evalNode(n: Node, ctx: Ctx): CellValue {
  switch (n.k) {
    case 'num':
      return n.v
    case 'str':
      return n.v
    case 'ref': {
      const a = parseAddr(n.v)
      if (!a) return { __error: '#REF!' }
      if (a.row < 0 || a.col < 0 || a.row >= ctx.grid.rows || a.col >= ctx.grid.cols) {
        return { __error: '#REF!' }
      }
      const key = `${a.row}:${a.col}`
      if (ctx.grid.hasFormula?.(a.row, a.col)) {
        if (ctx.visiting.has(key)) return { __error: '#CYCLE!' }
        ctx.visiting.add(key)
        try {
          return ctx.evaluateFormula(a.row, a.col)
        } finally {
          ctx.visiting.delete(key)
        }
      }
      return ctx.grid.get(a.row, a.col)
    }
    case 'range': {
      const a = parseAddr(n.a)
      const b = parseAddr(n.b)
      if (!a || !b) return { __error: '#REF!' }
      const r0 = Math.min(a.row, b.row)
      const r1 = Math.max(a.row, b.row)
      const c0 = Math.min(a.col, b.col)
      const c1 = Math.max(a.col, b.col)
      const out: CellValue[] = []
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${r}:${c}`
          if (ctx.grid.hasFormula?.(r, c)) {
            if (ctx.visiting.has(key)) {
              out.push({ __error: '#CYCLE!' })
              continue
            }
            ctx.visiting.add(key)
            try {
              out.push(ctx.evaluateFormula(r, c))
            } finally {
              ctx.visiting.delete(key)
            }
          } else {
            out.push(ctx.grid.get(r, c))
          }
        }
      }
      return out as any
    }
    case 'pct':
      return num(evalNode(n.e, ctx)) / 100
    case 'un':
      return -num(evalNode(n.e, ctx))
    case 'bin': {
      if (n.op === '&') {
        return `${strOf(evalNode(n.l, ctx))}${strOf(evalNode(n.r, ctx))}`
      }
      if (['=', '!=', '<', '>', '<=', '>='].includes(n.op)) {
        const l = evalNode(n.l, ctx)
        const r = evalNode(n.r, ctx)
        const bothNum = typeof l === 'number' || typeof r === 'number'
        const a: any = bothNum ? num(l) : strOf(l)
        const b: any = bothNum ? num(r) : strOf(r)
        switch (n.op) {
          case '=':
            return a === b ? 1 : 0
          case '!=':
            return a !== b ? 1 : 0
          case '<':
            return a < b ? 1 : 0
          case '>':
            return a > b ? 1 : 0
          case '<=':
            return a <= b ? 1 : 0
          case '>=':
            return a >= b ? 1 : 0
        }
      }
      const l = evalNode(n.l, ctx)
      const r = evalNode(n.r, ctx)
      const a = num(l)
      const b = num(r)
      switch (n.op) {
        case '+':
          return round12(a + b)
        case '-':
          return round12(a - b)
        case '*':
          return round12(a * b)
        case '/':
          return b === 0 ? { __error: '#DIV/0!' } : round12(a / b)
        case '^':
          return round12(Math.pow(a, b))
      }
      return { __error: '#VALUE!' }
    }
    case 'call':
      return callFunction(n.name, n.args, ctx)
  }
}

const round12 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e12) / 1e12 : v)

function strOf(v: CellValue): string {
  if (v === null || v === undefined) return ''
  if (isError(v)) return (v as FormulaError).__error
  return String(v)
}

function flat(args: CellValue[]): number[] {
  const out: number[] = []
  for (const a of args) {
    if (Array.isArray(a as any)) out.push(...flat(a as any))
    else if (typeof a === 'number') out.push(a)
    else if (typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a.replace(/,/g, '')))) {
      out.push(Number(a.replace(/,/g, '')))
    }
  }
  return out
}

const FUNCS: Record<string, (args: CellValue[]) => CellValue> = {
  SUM: (a) => round12(flat(a).reduce((x, y) => x + y, 0)),
  AVERAGE: (a) => {
    const v = flat(a)
    return v.length ? round12(v.reduce((x, y) => x + y, 0) / v.length) : { __error: '#DIV/0!' }
  },
  AVG: (a) => FUNCS.AVERAGE(a),
  MIN: (a) => (flat(a).length ? Math.min(...flat(a)) : 0),
  MAX: (a) => (flat(a).length ? Math.max(...flat(a)) : 0),
  COUNT: (a) => flat(a).length,
  COUNTA: (a) => a.flat(Infinity as any).filter((x: any) => x !== null && x !== undefined && x !== '').length,
  MEDIAN: (a) => {
    const v = flat(a).sort((x, y) => x - y)
    if (!v.length) return 0
    const mid = Math.floor(v.length / 2)
    return v.length % 2 ? v[mid] : round12((v[mid - 1] + v[mid]) / 2)
  },
  ROUND: (a) => {
    const d = a.length > 1 ? num(a[1]) : 0
    const f = Math.pow(10, d)
    return Math.round(num(a[0]) * f) / f
  },
  ROUNDUP: (a) => {
    const d = a.length > 1 ? num(a[1]) : 0
    const f = Math.pow(10, d)
    return Math.ceil(num(a[0]) * f) / f
  },
  ROUNDDOWN: (a) => {
    const d = a.length > 1 ? num(a[1]) : 0
    const f = Math.pow(10, d)
    return Math.floor(num(a[0]) * f) / f
  },
  INT: (a) => Math.floor(num(a[0])),
  ABS: (a) => Math.abs(num(a[0])),
  SQRT: (a) => (num(a[0]) < 0 ? { __error: '#VALUE!' } : Math.sqrt(num(a[0]))),
  POWER: (a) => Math.pow(num(a[0]), num(a[1])),
  EXP: (a) => Math.exp(num(a[0])),
  LN: (a) => (num(a[0]) <= 0 ? { __error: '#VALUE!' } : Math.log(num(a[0]))),
  LOG: (a) => Math.log(num(a[0])) / Math.log(a.length > 1 ? num(a[1]) : 10),
  MOD: (a) => (num(a[1]) === 0 ? { __error: '#DIV/0!' } : num(a[0]) % num(a[1])),
  IF: (a) => (toBool(a[0]) ? (a.length > 1 ? a[1] : 1) : a.length > 2 ? a[2] : 0),
  AND: (a) => (a.every((x) => toBool(x)) ? 1 : 0),
  OR: (a) => (a.some((x) => toBool(x)) ? 1 : 0),
  NOT: (a) => (toBool(a[0]) ? 0 : 1),
  ISBLANK: (a) => (a[0] === null || a[0] === undefined || a[0] === '' ? 1 : 0),
  ISNUMBER: (a) => (typeof a[0] === 'number' ? 1 : 0),
  LEN: (a) => strOf(a[0]).length,
  LEFT: (a) => strOf(a[0]).slice(0, a.length > 1 ? num(a[1]) : 1),
  RIGHT: (a) => {
    const n = a.length > 1 ? num(a[1]) : 1
    return strOf(a[0]).slice(-n)
  },
  MID: (a) => strOf(a[0]).slice(num(a[1]) - 1, num(a[1]) - 1 + num(a[2])),
  UPPER: (a) => strOf(a[0]).toUpperCase(),
  LOWER: (a) => strOf(a[0]).toLowerCase(),
  TRIM: (a) => strOf(a[0]).trim(),
  CONCAT: (a) => a.map((x) => strOf(x)).join(''),
}

function callFunction(name: string, args: Node[], ctx: Ctx): CellValue {
  const fn = FUNCS[name]
  if (!fn) return { __error: '#NAME?' }
  const values = args.map((a) => evalNode(a, ctx))
  const firstErr = values.find((v) => isError(v))
  if (firstErr && name !== 'IF' && name !== 'ISBLANK') return firstErr
  return fn(values as CellValue[])
}

/** 计算单条公式（无循环检测上下文时用） */
export function evaluate(formula: string, grid: Grid): CellValue {
  try {
    const ast = parse(formula)
    return evalNode(ast, { grid, visiting: new Set(), evaluateFormula: () => null })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('未知名称')) return { __error: '#NAME?' }
    return { __error: '#ERROR!' }
  }
}

/**
 * 重算整张表：返回「地址 → 值」映射。
 * 支持跨单元格引用（含链式与循环检测）。
 */
export function recalc(sheet: {
  columns: { key: string }[]
  rows: { key: string; label: string; cells: Record<string, any> }[]
}): Map<string, CellValue> {
  const cols = sheet.columns.length + 1 // A 列是科目名
  const rows = sheet.rows.length + 1 // 第 1 行是表头
  const formulaAt = new Map<string, string>() // "r:c" → formula
  const rawAt = new Map<string, CellValue>()

  rawAt.set('0:0', '科目')
  sheet.columns.forEach((c, i) => rawAt.set(`0:${i + 1}`, (c as any).label ?? ''))
  sheet.rows.forEach((r, ri) => {
    rawAt.set(`${ri + 1}:0`, r.label ?? '')
    sheet.columns.forEach((c, ci) => {
      const cell = r.cells?.[c.key]
      if (!cell) return
      const key = `${ri + 1}:${ci + 1}`
      if (typeof cell.formula === 'string' && cell.formula.trim().startsWith('=')) {
        formulaAt.set(key, cell.formula)
      } else if (cell.value !== undefined && cell.value !== null) {
        rawAt.set(key, cell.value as CellValue)
      }
    })
  })

  const grid: Grid = {
    cols,
    rows,
    get: (r, c) => rawAt.get(`${r}:${c}`) ?? null,
    hasFormula: (r, c) => formulaAt.has(`${r}:${c}`),
  }

  const cache = new Map<string, CellValue>()
  const visiting = new Set<string>()
  const evalAt = (r: number, c: number): CellValue => {
    const key = `${r}:${c}`
    if (cache.has(key)) return cache.get(key)!
    const f = formulaAt.get(key)
    if (!f) return rawAt.get(key) ?? null
    if (visiting.has(key)) return { __error: '#CYCLE!' }
    visiting.add(key)
    try {
      let v: CellValue
      try {
        v = evalNode(parse(f), { grid, visiting, evaluateFormula: evalAt })
      } catch {
        v = { __error: '#ERROR!' }
      }
      cache.set(key, v)
      return v
    } finally {
      visiting.delete(key)
    }
  }

  const out = new Map<string, CellValue>()
  for (const key of formulaAt.keys()) {
    const [r, c] = key.split(':').map(Number)
    out.set(key, evalAt(r, c))
  }
  return out
}

/** 把「r:c」地址换算成 A1（供 UI 显示） */
export function rrToA1(key: string): string {
  const [r, c] = key.split(':').map(Number)
  return addr(c, r)
}

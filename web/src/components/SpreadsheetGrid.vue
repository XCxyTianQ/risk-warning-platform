<script setup lang="ts">
/**
 * 表格栅格（Excel 式交互）：
 *  - 单元格编辑（双击/直接输入/Enter/Tab/Esc/方向键）
 *  - 区域选择：拖选、Shift+点击扩选、Ctrl+A 全选、点行列头选整行/整列
 *  - 复制/剪切/粘贴（系统剪贴板 TSV 互通）、Delete 清空
 *  - 填充：Ctrl+D 向下、Ctrl+R 向右
 *  - 行列：在选区插入/删除、点击列头排序
 *  - 公式：=SUM(B2:B5) 等，实时计算并回写到 value（后端只读数值）
 *  - 撤销/重做由父组件持有（本组件只发出 after-change 事件）
 */
import { computed, nextTick, ref, watch } from 'vue'

import { evaluate, recalc, errText, isError, type CellValue } from '../lib/formula'

export interface GridColumn {
  key: string
  label: string
  period?: string
  report_type?: string
}

export interface GridCell {
  value?: number | string | null
  formula?: string
  source?: string
  confidence?: number
  format?: string
}

export interface GridRow {
  key: string
  label: string
  field?: string
  cells: Record<string, GridCell>
}

const props = defineProps<{
  columns: GridColumn[]
  rows: GridRow[]
  /** 只读模式（默认可编辑；Vue 对未传的 Boolean prop 会取 false，故用反向语义） */
  readonly?: boolean
  /** 后端勾稽校验结果：`行key:列key` → error | warn */
  issues?: Record<string, string>
}>()

/** 该单元格的后端校验级别（用于标红/标黄） */
function issueLevel(r: number, c: number): string {
  if (r === 0 || c === 0) return ''
  const row = props.rows[r - 1]
  const col = props.columns[c - 1]
  if (!row || !col) return ''
  return props.issues?.[`${row.key}:${col.key}`] ?? ''
}

const emit = defineEmits<{
  /** 数据变更（已重算公式）：cells 为增量 */
  (e: 'change', payload: { patch: { row: string; col: string; value: number | string | null; formula?: string }[] }): void
  (e: 'structure', payload: { action: 'insert-row' | 'delete-row' | 'insert-col' | 'delete-col' | 'sort'; index: number; asc?: boolean; count?: number }): void
  (e: 'rename-row', payload: { index: number; label: string }): void
  (e: 'set-period', payload: { index: number; period: string }): void
  (e: 'select', payload: { rows: number; cols: number }): void
}>()

// ---------- 选区 ----------
const sel = ref({ r0: 0, c0: 0, r1: 0, c1: 0 }) // 含表头：第 0 行是期间标题，第 0 列是科目
const anchor = ref({ r: 0, c: 0 })
const dragging = ref(false)
const editing = ref<{ r: number; c: number } | null>(null)
const editText = ref('')
const container = ref<HTMLDivElement | null>(null)

const rowCount = computed(() => props.rows.length + 1)
const colCount = computed(() => props.columns.length + 1)

const selNorm = computed(() => ({
  r0: Math.min(sel.value.r0, sel.value.r1),
  r1: Math.max(sel.value.r0, sel.value.r1),
  c0: Math.min(sel.value.c0, sel.value.c1),
  c1: Math.max(sel.value.c0, sel.value.c1),
}))

const activeCell = computed(() => ({ r: sel.value.r0, c: sel.value.c0 }))
// 当前单元格地址（未在模板中使用，保留供调试）\nconst activeRef = computed(() => addr(activeCell.value.c, activeCell.value.r))\nvoid activeRef

function inSel(r: number, c: number): boolean {
  const s = selNorm.value
  return r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1
}

// ---------- 取/存值 ----------
function rawCell(r: number, c: number): GridCell | null {
  if (r === 0 || c === 0) return null
  const row = props.rows[r - 1]
  const col = props.columns[c - 1]
  if (!row || !col) return null
  return row.cells?.[col.key] ?? null
}

function headerText(r: number, c: number): string {
  if (r === 0 && c === 0) return '科目 / 期间'
  if (r === 0) return props.columns[c - 1]?.label ?? ''
  if (c === 0) return props.rows[r - 1]?.label ?? ''
  return ''
}

/** 显示文本：公式单元格显示计算结果，其余显示数值 */
function display(r: number, c: number): string {
  const cell = rawCell(r, c)
  if (!cell) return ''
  const v = cell.value
  if (v === null || v === undefined || v === '') return ''
  const fmt = cell.format ?? ''
  if (typeof v === 'number') {
    if (fmt === 'percent') return `${(v * 100).toFixed(2)}%`
    if (fmt === 'int') return Math.round(v).toLocaleString('zh-CN')
    if (fmt === 'money') return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return String(Math.round(v * 1e6) / 1e6)
  }
  return String(v)
}

/** 公式错误显示 */
function displayWithError(r: number, c: number): { text: string; error: boolean; formula: boolean } {
  const cell = rawCell(r, c)
  if (!cell) return { text: '', error: false, formula: false }
  const isFormula = typeof cell.formula === 'string' && cell.formula.startsWith('=')
  if (isError(cell.value as any)) return { text: errText(cell.value), error: true, formula: isFormula }
  return { text: display(r, c), error: false, formula: isFormula }
}

function formulaOf(r: number, c: number): string {
  return rawCell(r, c)?.formula ?? ''
}

function sourceOf(r: number, c: number): string {
  const s = rawCell(r, c)?.source ?? ''
  return s === 'vision' ? 'AI' : s === 'file' ? '文件' : ''
}

// ---------- 编辑 ----------
function startEdit(r: number, c: number, initial?: string) {
  if (props.readonly || r === 0 || c === 0) return
  editing.value = { r, c }
  editText.value = initial ?? (formulaOf(r, c) || display(r, c))
  nextTick(() => {
    const el = container.value?.querySelector<HTMLInputElement>('input.cell-input')
    el?.focus()
    el?.select()
  })
}

function commitEdit(move: 'down' | 'right' | 'none' = 'none') {
  const e = editing.value
  if (!e) return
  editing.value = null
  const text = editText.value.trim()
  const row = props.rows[e.r - 1]
  const col = props.columns[e.c - 1]
  if (!row || !col) return

  const patch: { row: string; col: string; value: number | string | null; formula?: string }[] = []
  if (text === '') {
    patch.push({ row: row.key, col: col.key, value: null })
  } else if (text.startsWith('=')) {
    const value = evaluate(text, gridFor(row.key))
    patch.push({
      row: row.key,
      col: col.key,
      value: isError(value) ? errText(value) : (value as number | string),
      formula: text,
    })
  } else {
    const n = Number(text.replace(/[,，\s]/g, '').replace(/%$/, ''))
    const isPct = text.endsWith('%')
    if (Number.isFinite(n)) {
      patch.push({ row: row.key, col: col.key, value: isPct ? n / 100 : n, formula: '' })
    } else {
      patch.push({ row: row.key, col: col.key, value: text, formula: '' })
    }
  }
  emit('change', { patch })
  if (move === 'down') moveActive(1, 0)
  if (move === 'right') moveActive(0, 1)
}

/** 供单格公式求值用的即时栅格（含本次编辑前的数据） */
function gridFor(_rowKey: string) {
  return {
    cols: colCount.value,
    rows: rowCount.value,
    get: (r: number, c: number): CellValue => {
      if (r === 0 || c === 0) return headerText(r, c)
      const cell = rawCell(r, c)
      if (!cell) return null
      if (typeof cell.formula === 'string' && cell.formula.startsWith('=')) {
        const v = evaluate(cell.formula, gridFor(_rowKey))
        return isError(v) ? errText(v) : (v as CellValue)
      }
      return (cell.value ?? null) as CellValue
    },
    hasFormula: (r: number, c: number) => {
      const cell = rawCell(r, c)
      return !!cell && typeof cell.formula === 'string' && cell.formula.startsWith('=')
    },
  }
}

/** 全表重算（父组件在数据变化后调用，返回需要回写的补丁） */
function recalcAll(): { row: string; col: string; value: number | string | null; formula?: string }[] {
  const sheet = {
    columns: props.columns.map((c) => ({ key: c.key, label: c.label })),
    rows: props.rows.map((r) => ({ key: r.key, label: r.label, cells: r.cells ?? {} })),
  }
  const values = recalc(sheet as any)
  const patch: { row: string; col: string; value: number | string | null; formula?: string }[] = []
  for (const [key, value] of values) {
    const [r, c] = key.split(':').map(Number)
    const row = props.rows[r - 1]
    const col = props.columns[c - 1]
    if (!row || !col) continue
    const current = row.cells?.[col.key]?.value
    const next = isError(value) ? errText(value) : (value as number | string)
    if (String(current ?? '') !== String(next ?? '')) {
      patch.push({ row: row.key, col: col.key, value: next, formula: row.cells?.[col.key]?.formula })
    }
  }
  return patch
}

defineExpose({ recalcAll })

// ---------- 键盘 / 剪贴板 ----------
function moveActive(dr: number, dc: number, extend = false) {
  const r = Math.max(0, Math.min(rowCount.value - 1, activeCell.value.r + dr))
  const c = Math.max(0, Math.min(colCount.value - 1, activeCell.value.c + dc))
  if (extend) {
    sel.value = { ...sel.value, r1: r, c1: c }
  } else {
    sel.value = { r0: r, c0: c, r1: r, c1: c }
    anchor.value = { r, c }
  }
  scrollIntoView(r, c)
  emit('select', { rows: r, cols: c })
}

function scrollIntoView(r: number, c: number) {
  nextTick(() => {
    const el = container.value?.querySelector<HTMLElement>(`[data-cell="${r}-${c}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent) {
  if (editing.value) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'c') {
    void copySelection(false)
    e.preventDefault()
    return
  }
  if (mod && e.key.toLowerCase() === 'x') {
    void copySelection(true)
    e.preventDefault()
    return
  }
  if (mod && e.key.toLowerCase() === 'v') {
    // 由 paste 事件处理（系统剪贴板）
    return
  }
  if (mod && e.key.toLowerCase() === 'a') {
    sel.value = { r0: 0, c0: 0, r1: rowCount.value - 1, c1: colCount.value - 1 }
    e.preventDefault()
    return
  }
  if (mod && e.key.toLowerCase() === 'd') {
    fillDown()
    e.preventDefault()
    return
  }
  if (mod && e.key.toLowerCase() === 'r') {
    fillRight()
    e.preventDefault()
    return
  }
  switch (e.key) {
    case 'ArrowUp':
      moveActive(-1, 0, e.shiftKey)
      e.preventDefault()
      break
    case 'ArrowDown':
      moveActive(1, 0, e.shiftKey)
      e.preventDefault()
      break
    case 'ArrowLeft':
      moveActive(0, -1, e.shiftKey)
      e.preventDefault()
      break
    case 'ArrowRight':
      moveActive(0, 1, e.shiftKey)
      e.preventDefault()
      break
    case 'Tab':
      moveActive(0, e.shiftKey ? -1 : 1)
      e.preventDefault()
      break
    case 'Enter':
      startEdit(activeCell.value.r, activeCell.value.c)
      e.preventDefault()
      break
    case 'F2':
      startEdit(activeCell.value.r, activeCell.value.c)
      e.preventDefault()
      break
    case 'Delete':
    case 'Backspace':
      clearSelection()
      e.preventDefault()
      break
    default:
      // 直接输入即编辑
      if (!mod && !e.altKey && e.key.length === 1) {
        startEdit(activeCell.value.r, activeCell.value.c, e.key)
        e.preventDefault()
      }
  }
}

async function copySelection(cut = false) {
  const s = selNorm.value
  if (s.r0 === 0 || s.c0 === 0) return
  const lines: string[] = []
  for (let r = s.r0; r <= s.r1; r++) {
    const line: string[] = []
    for (let c = s.c0; c <= s.c1; c++) line.push(display(r, c))
    lines.push(line.join('\t'))
  }
  const text = lines.join('\n')
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    /* 剪贴板不可用（无权限）时忽略 */
  }
  if (cut) clearSelection()
}

function clearSelection() {
  const s = selNorm.value
  const patch: { row: string; col: string; value: null }[] = []
  for (let r = s.r0; r <= s.r1; r++) {
    for (let c = s.c0; c <= s.c1; c++) {
      if (r === 0 || c === 0) continue
      const row = props.rows[r - 1]
      const col = props.columns[c - 1]
      if (row && col) patch.push({ row: row.key, col: col.key, value: null })
    }
  }
  if (patch.length) emit('change', { patch })
}

function fillDown() {
  const s = selNorm.value
  if (s.r1 <= s.r0) return
  const patch: any[] = []
  for (let c = s.c0; c <= s.c1; c++) {
    if (c === 0) continue
    const src = rawCell(s.r0, c)
    if (!src) continue
    for (let r = s.r0 + 1; r <= s.r1; r++) {
      const row = props.rows[r - 1]
      const col = props.columns[c - 1]
      if (!row || !col) continue
      patch.push({ row: row.key, col: col.key, value: src.value ?? null, formula: src.formula })
    }
  }
  if (patch.length) emit('change', { patch })
}

function fillRight() {
  const s = selNorm.value
  if (s.c1 <= s.c0) return
  const patch: any[] = []
  for (let r = s.r0; r <= s.r1; r++) {
    if (r === 0) continue
    const src = rawCell(r, s.c0)
    if (!src) continue
    for (let c = s.c0 + 1; c <= s.c1; c++) {
      const row = props.rows[r - 1]
      const col = props.columns[c - 1]
      if (!row || !col) continue
      patch.push({ row: row.key, col: col.key, value: src.value ?? null, formula: src.formula })
    }
  }
  if (patch.length) emit('change', { patch })
}

/** 系统剪贴板粘贴（TSV）：从活动单元格起铺开 */
function onPaste(e: ClipboardEvent) {
  if (editing.value) return
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text.trim()) return
  e.preventDefault()
  const grid = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => line.split('\t'))
  const patch: any[] = []
  const start = selNorm.value
  for (let dr = 0; dr < grid.length; dr++) {
    for (let dc = 0; dc < grid[dr].length; dc++) {
      const r = start.r0 + dr
      const c = start.c0 + dc
      if (r === 0 || c === 0 || r >= rowCount.value || c >= colCount.value) continue
      const row = props.rows[r - 1]
      const col = props.columns[c - 1]
      if (!row || !col) continue
      const raw = grid[dr][dc].trim()
      if (raw.startsWith('=')) {
        const v = evaluate(raw, gridFor(row.key))
        patch.push({ row: row.key, col: col.key, value: isError(v) ? errText(v) : v, formula: raw })
      } else {
        const n = Number(raw.replace(/[,，\s]/g, '').replace(/%$/, ''))
        const isPct = raw.endsWith('%')
        patch.push({
          row: row.key,
          col: col.key,
          value: raw === '' ? null : Number.isFinite(n) ? (isPct ? n / 100 : n) : raw,
          formula: '',
        })
      }
    }
  }
  if (patch.length) emit('change', { patch })
}

// ---------- 鼠标 ----------
function onCellMouseDown(r: number, c: number, e: MouseEvent) {
  if (editing.value) commitEdit()
  if (e.shiftKey) {
    sel.value = { ...sel.value, r1: r, c1: c }
  } else {
    sel.value = { r0: r, c0: c, r1: r, c1: c }
    anchor.value = { r, c }
  }
  dragging.value = true
  emit('select', { rows: r, cols: c })
}

function onCellMouseEnter(r: number, c: number) {
  if (!dragging.value) return
  sel.value = { ...sel.value, r1: r, c1: c }
}

function onCellDblClick(r: number, c: number) {
  startEdit(r, c)
}

function onDocMouseUp() {
  dragging.value = false
}

watch(
  () => props.rows.length,
  () => {
    // 结构变化后把选区夹回有效范围
    const r = Math.min(activeCell.value.r, rowCount.value - 1)
    const c = Math.min(activeCell.value.c, colCount.value - 1)
    sel.value = { r0: r, c0: c, r1: r, c1: c }
  },
)
</script>

<template>
  <div
    ref="container"
    class="sheet"
    tabindex="0"
    @keydown="onKeydown"
    @paste="onPaste"
    @mouseup="onDocMouseUp"
    @mouseleave="onDocMouseUp"
  >
    <table class="grid">
      <thead>
        <tr>
          <th class="corner" @click="sel = { r0: 0, c0: 0, r1: rowCount - 1, c1: colCount - 1 }">
            <span class="corner-label">科目 / 期间</span>
          </th>
          <th
            v-for="(c, ci) in columns"
            :key="c.key"
            class="col-head"
            :class="{ sel: inSel(0, ci + 1), active: activeCell.c === ci + 1 }"
            @mousedown="onCellMouseDown(0, ci + 1, $event)"
            @mouseenter="onCellMouseEnter(0, ci + 1)"
          >
            <div class="head-label">{{ c.label }}</div>
            <div class="head-period">
              <input
                v-if="!readonly"
                class="mini"
                :value="c.period"
                @mousedown.stop
                @change="$emit('set-period', { index: ci + 1, period: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <div class="head-actions">
              <i title="按该列降序排序" @mousedown.stop @click="$emit('structure', { action: 'sort', index: ci + 1, asc: false })">▼</i>
              <i title="按该列升序排序" @mousedown.stop @click="$emit('structure', { action: 'sort', index: ci + 1, asc: true })">▲</i>
              <i title="删除该列" @mousedown.stop @click="$emit('structure', { action: 'delete-col', index: ci + 1 })">✕</i>
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in rows" :key="row.key">
          <th
            class="row-head"
            :class="{ sel: inSel(ri + 1, 0), active: activeCell.r === ri + 1 }"
            @mousedown="onCellMouseDown(ri + 1, 0, $event)"
            @mouseenter="onCellMouseEnter(ri + 1, 0)"
          >
            <div class="row-label">
              <input
                v-if="!readonly"
                class="mini label"
                :value="row.label"
                @mousedown.stop
                @change="$emit('rename-row', { index: ri + 1, label: ($event.target as HTMLInputElement).value })"
                :data-row-key="row.key"
              />
              <span v-else>{{ row.label }}</span>
              <span v-if="row.field" class="mapped" :title="`已映射到引擎字段 ${row.field}`">✓</span>
            </div>
            <div class="row-actions">
              <i title="在上方插入行" @mousedown.stop @click="$emit('structure', { action: 'insert-row', index: ri + 1 })">＋</i>
              <i title="删除该行" @mousedown.stop @click="$emit('structure', { action: 'delete-row', index: ri + 1 })">✕</i>
            </div>
          </th>
          <td
            v-for="(col, ci) in columns"
            :key="col.key"
            class="cell"
            :data-cell="`${ri + 1}-${ci + 1}`"
            :class="{
              sel: inSel(ri + 1, ci + 1),
              active: activeCell.r === ri + 1 && activeCell.c === ci + 1,
              err: displayWithError(ri + 1, ci + 1).error || issueLevel(ri + 1, ci + 1) === 'error',
              warn: rawCell(ri + 1, ci + 1)?.source === 'vision' || issueLevel(ri + 1, ci + 1) === 'warn',
            }"
            :title="rawCell(ri + 1, ci + 1)?.source === 'vision' ? '模型识别，待核对确认' : ''"
            @mousedown="onCellMouseDown(ri + 1, ci + 1, $event)"
            @mouseenter="onCellMouseEnter(ri + 1, ci + 1)"
            @dblclick="onCellDblClick(ri + 1, ci + 1)"
          >
            <input
              v-if="editing && editing.r === ri + 1 && editing.c === ci + 1"
              v-model="editText"
              class="cell-input"
              @keydown.enter.prevent="commitEdit('down')"
              @keydown.tab.prevent="commitEdit('right')"
              @keydown.esc.prevent="editing = null"
              @change="commitEdit()"
              @blur="commitEdit()"
            />
            <template v-else>
              <span class="cell-text">{{ displayWithError(ri + 1, ci + 1).text }}</span>
              <i v-if="formulaOf(ri + 1, ci + 1)" class="fx" title="公式单元格">ƒ</i>
              <i v-else-if="sourceOf(ri + 1, ci + 1)" class="src" :title="`来源：${sourceOf(ri + 1, ci + 1)}`">
                {{ sourceOf(ri + 1, ci + 1) }}
              </i>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.sheet {
  overflow: auto;
  max-height: 100%;
  outline: none;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--card);
}

.grid {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  font-size: 12.5px;
  user-select: none;
}

.grid th,
.grid td {
  border-bottom: 1px solid var(--border-soft);
  border-right: 1px solid var(--border-soft);
  padding: 3px 8px;
  text-align: right;
  position: relative;
  min-width: 96px;
  height: 26px;
}

.grid thead th {
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  z-index: 3;
  font-weight: 600;
  text-align: right;
}

.grid .corner,
.grid .row-head {
  text-align: left;
  position: sticky;
  left: 0;
  background: var(--card);
  z-index: 2;
  min-width: 168px;
}

.grid thead .corner {
  z-index: 4;
  cursor: pointer;
}

.corner-label {
  font-size: 10.5px;
  color: var(--text-sub);
}

.col-head .head-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.head-period {
  height: 0;
  overflow: hidden;
}

.head-actions,
.row-actions {
  position: absolute;
  right: 4px;
  top: 4px;
  display: none;
  gap: 3px;
}

.col-head:hover .head-actions,
.row-head:hover .row-actions {
  display: inline-flex;
}

.head-actions i,
.row-actions i {
  font-style: normal;
  font-size: 10px;
  color: var(--text-sub);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 3px;
  cursor: pointer;
  background: var(--card);
}

.head-actions i:hover,
.row-actions i:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.row-label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cell {
  cursor: cell;
}

.cell.sel,
th.sel {
  background: rgba(37, 99, 235, 0.08);
}

.cell.active,
th.active {
  box-shadow: inset 0 0 0 2px var(--primary);
  background: var(--card);
}

.cell.err {
  background: rgba(220, 38, 38, 0.12);
}

.cell.warn {
  background: rgba(234, 179, 8, 0.12);
}

.cell-text {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-input {
  position: absolute;
  inset: 0;
  width: 100%;
  text-align: right;
  border: 2px solid var(--primary);
  border-radius: 3px;
  font-family: inherit;
  font-size: 12.5px;
  padding: 2px 6px;
  background: var(--card);
  color: var(--text);
  z-index: 5;
}

.mini {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  padding: 1px 3px;
  border-radius: 4px;
}

.mini:hover {
  border-color: var(--border);
}

.mapped {
  font-size: 9.5px;
  color: #16a34a;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 3px;
}

.fx {
  position: absolute;
  left: 3px;
  top: 50%;
  transform: translateY(-50%);
  font-style: italic;
  font-size: 9.5px;
  color: #7c3aed;
}

.src {
  position: absolute;
  left: 3px;
  top: 50%;
  transform: translateY(-50%);
  font-style: normal;
  font-size: 8.5px;
  color: #b45309;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 2px;
}
</style>

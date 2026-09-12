<script setup lang="ts">
/**
 * 财报表格面板：在线创建 / 在线编辑 / 勾稽校验 / 入库。
 *
 * 设计要点：
 *  - 「表格」是平台的一等对象：可以空白新建、从模板新建，也可以由图片识别/文件解析填充（后续接入）
 *  - 单元格可直接编辑；支持从 Excel 复制后**粘贴一块区域**（TSV 批量填充）
 *  - 单位/口径/期间是元数据，显示在表头，入库前强校验
 *  - 勾稽校验不通过 → 后端拒绝入库，错误在表头横幅与单元格上标出
 *  - 入库默认不覆盖公开信源数据，冲突逐期提示
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { api, type TableDoc, type TableRow, type TableValidation } from '../api'
import SpreadsheetGrid from '../components/SpreadsheetGrid.vue'
import { BUILTIN_MACROS, runMacro, type Macro } from '../lib/macros'
import { pivot as computePivot, pivotFields, pivotToSheet, type PivotResult, type PivotSpec } from '../lib/pivot'
import { openPanel } from '../workspace/store'

const props = defineProps<{ tableId?: number }>()

const CURRENT_YEAR = new Date().getFullYear()

const docs = ref<TableRow[]>([])
const doc = ref<TableDoc | null>(null)
const validation = ref<TableValidation | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const toast = ref('')

// 工作表页签
const sheetList = computed(() => doc.value?.sheets ?? [])
const activeSheet = computed(() => doc.value?.active ?? '')

// 数据透视表
const pivotOpen = ref(false)
const pivotSpec = ref<PivotSpec>({ rowField: '__label', colField: '', valueField: '', agg: 'sum' })
const pivotResult = ref<PivotResult | null>(null)
const pivotSheetName = ref('透视表')

// 宏
const macroOpen = ref(false)
const macroList = ref<Macro[]>([])
const macroIndex = ref(0)
const macroCode = ref('')
const macroName = ref('')
const macroLogs = ref<string[]>([])
const macroError = ref('')

// 图片识别导入
const imageInput = ref<HTMLInputElement | null>(null)
const reading = ref<import('../api').Reading | null>(null)
const readingOpen = ref(false)
const readingBusy = ref(false)

// 文件/粘贴导入（确定性解析）
const importOpen = ref(false)
const importBusy = ref(false)
const importForm = ref({ enterprise_id: null as number | null, title: '', unit: '', scope: '', text: '' })
const sheetInput = ref<HTMLInputElement | null>(null)

// 撤销 / 重做栈（客户端快照，各 30 步）
const undoStack = ref<{ sheet: any; label: string }[]>([])
const redoStack = ref<{ sheet: any; label: string }[]>([])
const gridRef = ref<InstanceType<typeof SpreadsheetGrid> | null>(null)
const selection = ref({ rows: 1, cols: 1 })

// 新建表
const newOpen = ref(false)
const enterprises = ref<{ id: number; name: string }[]>([])
const templates = ref<{ kind: string; title: string }[]>([])
const form = ref({
  enterprise_id: null as number | null,
  title: '',
  kind: 'blank',
  periods: [`${CURRENT_YEAR}`, `${CURRENT_YEAR - 1}`],
  unit: '万元',
  scope: '合并报表',
})

// 入库
const previewOpen = ref(false)
const preview = ref<{ plan: { period: string; report_type: string; action: string; existing_source: string | null }[] } | null>(null)
const ingestNote = ref('')

const columns = computed(() => doc.value?.sheet.columns ?? [])
const rows = computed(() => doc.value?.sheet.rows ?? [])
/** 单元格级校验问题 → 栅格标红/标黄（key: `行key:列key`） */
const cellIssues = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const i of validation.value?.issues ?? []) {
    if (i.row && i.col) out[`${i.row}:${i.col}`] = i.level
  }
  return out
})
const statusLabel = computed(() => {
  const s = doc.value?.status
  return s === 'ingested' ? '已入库' : s === 'confirmed' ? '已确认' : '草稿'
})
const errorIssues = computed(() => (validation.value?.issues ?? []).filter((i) => i.level === 'error'))
const otherIssues = computed(() => (validation.value?.issues ?? []).filter((i) => i.level !== 'error').slice(0, 6))
/** 待确认的模型识别单元格数量（识别结果默认待确认，确认前禁止入库） */
const visionCells = computed(() => {
  const out: { row: string; col: string }[] = []
  for (const r of rows.value) {
    for (const [col, cell] of Object.entries(r.cells ?? {})) {
      if ((cell as any)?.source === 'vision') out.push({ row: r.key, col })
    }
  }
  return out
})
const visionCellCount = computed(() => visionCells.value.length)
const hasVisionCells = computed(() => visionCellCount.value > 0)

/** 当前活动单元格的公式（编辑栏显示） */
const activeFormula = ref('')
const activeRef = ref('A1')
function onSelect(payload: { rows: number; cols: number }) {
  selection.value = payload
  const row = rows.value[payload.rows - 1]
  const col = columns.value[payload.cols - 1]
  activeRef.value = col ? `${col.period}${row ? ' · ' + row.label : ''}` : row ? row.label : ''
  activeFormula.value = row && col ? (row.cells?.[col.key]?.formula ?? '') : ''
}

async function loadList() {
  try {
    docs.value = (await api.tables()).items
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function loadDoc(id: number) {
  loading.value = true
  error.value = ''
  try {
    doc.value = await api.table(id)
    await runValidate()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function loadMeta() {
  try {
    const [tpl, ents] = await Promise.all([api.tableTemplates(), api.enterprises()])
    templates.value = tpl.templates
    enterprises.value = ents.items
  } catch {
    /* 元数据失败不阻塞编辑 */
  }
}

async function create() {
  saving.value = true
  error.value = ''
  try {
    const r = await api.createTable({
      enterprise_id: form.value.enterprise_id,
      title: form.value.title,
      kind: form.value.kind,
      periods: form.value.periods.filter(Boolean),
      unit: form.value.unit,
      scope: form.value.scope,
      origin: 'manual',
    })
    doc.value = r.table
    newOpen.value = false
    await runValidate()
    await loadList()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

/** 改名（科目标题）：改完自动重新映射 */
async function renameRow(rowKey: string, label: string) {
  if (!doc.value) return
  const target = doc.value.sheet.rows.find((r) => r.key === rowKey)
  if (!target || target.label === label) return
  pushUndo('改科目名')
  target.label = label
  try {
    await api.updateTable(doc.value.id, { sheet: JSON.parse(JSON.stringify(doc.value.sheet)) })
    await loadDoc(doc.value.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}

/** 修改某期间列的年份/报告类型 */
async function setColumnPeriod(colKey: string, patch: { period?: string; report_type?: string }) {
  if (!doc.value) return
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  const col = sheet.columns.find((c: any) => c.key === colKey)
  if (!col) return
  Object.assign(col, patch)
  col.label = `${col.period}${col.report_type ?? ''}`
  try {
    await api.updateTable(doc.value.id, { sheet })
    await loadDoc(doc.value.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}

// ---------- 表格栅格事件（单元格编辑 / 公式 / 结构变更） ----------

/** 保存定时器：连续编辑合并成一次 PATCH，避免频繁往返 */
let saveTimer: number | undefined

function scheduleSave(label: string) {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    if (!doc.value) return
    try {
      await api.updateTable(doc.value.id, { sheet: JSON.parse(JSON.stringify(doc.value.sheet)) })
      await runValidate()
    } catch (e) {
      error.value = (e as Error).message
    }
  }, 500)
  void label
}

/** 应用一批单元格变更（含公式重算结果），随后整表落库 */
function onCellsChange(payload: { patch: { row: string; col: string; value: any; formula?: string }[] }) {
  if (!doc.value || !payload.patch.length) return
  pushUndo('编辑单元格')
  for (const p of payload.patch) {
    const row = doc.value.sheet.rows.find((r) => r.key === p.row)
    if (!row) continue
    if (p.value === null) {
      delete row.cells[p.col]
      continue
    }
    const prev = row.cells[p.col] ?? {}
    const next: any = { ...prev, value: p.value, source: prev.source === 'vision' ? 'user' : (prev.source ?? 'user'), confidence: 1 }
    // 人工改动过 → 视为已确认（vision 角标消失）
    if (p.formula && p.formula.trim()) next.formula = p.formula
    else delete next.formula
    row.cells[p.col] = next
  }
  recalcFormulas()
  scheduleSave('编辑')
}

/** 重算所有公式单元格（引用变化后联动） */
function recalcFormulas() {
  const patch = gridRef.value?.recalcAll?.() ?? []
  if (!doc.value || !patch.length) return
  for (const p of patch) {
    const row = doc.value.sheet.rows.find((r) => r.key === p.row)
    if (!row) continue
    const prev = row.cells[p.col] ?? {}
    row.cells[p.col] = { ...prev, value: p.value, ...(p.formula ? { formula: p.formula } : {}) }
  }
}

/** 结构变更：插入/删除行列、排序 */
async function onStructure(payload: { action: string; index: number; asc?: boolean }) {
  if (!doc.value) return
  pushUndo(
    payload.action === 'sort' ? '排序' : payload.action.startsWith('insert') ? '插入' : '删除',
  )
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  const { action, index } = payload
  if (action === 'insert-row') {
    sheet.rows.splice(index - 1, 0, { key: `r${Date.now().toString(36)}`, label: '新科目', field: '', cells: {} })
  } else if (action === 'delete-row') {
    sheet.rows.splice(index - 1, 1)
  } else if (action === 'delete-col') {
    if (sheet.columns.length <= 1) {
      error.value = '至少保留一个期间列'
      return
    }
    const col = sheet.columns[index - 1]
    sheet.columns.splice(index - 1, 1)
    for (const r of sheet.rows) if (col) delete r.cells?.[col.key]
  } else if (action === 'sort') {
    const col = sheet.columns[index - 1]
    const asc = payload.asc !== false
    const val = (r: any) => {
      if (!col) return String(r.label)
      const v = r.cells?.[col.key]?.value
      return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY
    }
    sheet.rows.sort((a: any, b: any) => (asc ? Number(val(a)) - Number(val(b)) : Number(val(b)) - Number(val(a))))
  }
  try {
    await api.updateTable(doc.value.id, { sheet })
    await loadDoc(doc.value.id)
    toast.value = `已应用：${action}`
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 3000)
}

// ---------- 撤销 / 重做 ----------

function snapshot(): any {
  return doc.value ? JSON.parse(JSON.stringify(doc.value.sheet)) : null
}

function pushUndo(label: string) {
  const snap = snapshot()
  if (!snap) return
  undoStack.value.push({ sheet: snap, label })
  if (undoStack.value.length > 30) undoStack.value.shift()
  redoStack.value = []
}

async function restore(entry: { sheet: any; label: string }) {
  if (!doc.value) return
  try {
    await api.updateTable(doc.value.id, { sheet: entry.sheet })
    await loadDoc(doc.value.id)
    toast.value = entry.label
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 2500)
}

async function undo() {
  if (!doc.value || !undoStack.value.length) return
  const current = snapshot()
  const last = undoStack.value.pop()!
  if (current) redoStack.value.push({ sheet: current, label: `已重做：${last.label.replace('已撤销：', '')}` })
  await restore({ sheet: last.sheet, label: `已撤销：${last.label}` })
}

async function redo() {
  if (!doc.value || !redoStack.value.length) return
  const current = snapshot()
  const next = redoStack.value.pop()!
  if (current) undoStack.value.push({ sheet: current, label: next.label.replace('已重做：', '') })
  await restore(next)
}

function onUndoKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault()
    void undo()
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault()
    void redo()
  }
}

// ---------- 确定性导入：文件（csv/xlsx/xls）或粘贴整段文本 ----------

async function pickSheetFile() {
  sheetInput.value?.click()
}

async function onPickSheet(e: Event) {
  const el = e.target as HTMLInputElement
  const f = el.files?.[0]
  el.value = ''
  if (!f) return
  importBusy.value = true
  error.value = ''
  try {
    const buf = await f.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    const up = await api.uploadAttachment({
      filename: f.name,
      mime: f.type || 'application/octet-stream',
      data_base64: btoa(bin),
      origin: 'upload',
    })
    const r = await api.importTable({
      attachment_id: up.attachment.id,
      enterprise_id: importForm.value.enterprise_id,
      title: importForm.value.title,
      unit: importForm.value.unit || undefined,
      scope: importForm.value.scope || undefined,
    })
    importOpen.value = false
    doc.value = r.table
    toast.value = `已解析 ${r.rows} 个科目 × ${r.columns.length} 期（映射 ${r.mapped_fields} 项）`
    await loadList()
    await runValidate()
  } catch (e2) {
    error.value = (e2 as Error).message
  } finally {
    importBusy.value = false
  }
  setTimeout(() => (toast.value = ''), 6000)
}

/** 粘贴的整段文本（从 Excel 直接复制）→ 新建表格 */
async function importFromText() {
  if (!importForm.value.text.trim()) return
  importBusy.value = true
  error.value = ''
  try {
    const r = await api.importTable({
      text: importForm.value.text,
      enterprise_id: importForm.value.enterprise_id,
      title: importForm.value.title,
      unit: importForm.value.unit || undefined,
      scope: importForm.value.scope || undefined,
    })
    importOpen.value = false
    importForm.value.text = ''
    doc.value = r.table
    toast.value = `已解析 ${r.rows} 个科目 × ${r.columns.length} 期（映射 ${r.mapped_fields} 项）`
    await loadList()
    await runValidate()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    importBusy.value = false
  }
  setTimeout(() => (toast.value = ''), 6000)
}

/** 从编辑栏输入公式应用到当前活动单元格 */
function applyFormulaFromBar(text: string) {
  if (!doc.value) return
  const row = rows.value[selection.value.rows - 1]
  const col = columns.value[selection.value.cols - 1]
  if (!row || !col) return
  const raw = text.trim()
  if (!raw) return
  onCellsChange({ patch: [{ row: row.key, col: col.key, value: raw.startsWith('=') ? '' : raw }] })
  // 直接写入公式文本，由栅格重算
  const target = doc.value.sheet.rows.find((r) => r.key === row.key)
  if (target) {
    target.cells[col.key] = { ...(target.cells[col.key] ?? {}), value: '', formula: raw.startsWith('=') ? raw : undefined, source: 'user', confidence: 1 }
    recalcFormulas()
    scheduleSave('公式')
  }
}

async function saveMeta(patch: Record<string, any>) {
  if (!doc.value) return
  try {
    await api.updateTable(doc.value.id, patch)
    Object.assign(doc.value, patch)
    await runValidate()
    toast.value = '已保存'
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 3000)
}

/** 追加一个期间列 */
async function addColumn() {
  if (!doc.value) return
  const label = prompt('新增列的标题（如 2026年报 / 备注 / 合计）', `列${columns.value.length + 1}`)
  if (label === null) return
  const period = prompt('该列的期间（年份，可留空；填了才能参与入库与同比）', '')
  pushUndo('新增列')
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  const key = `c_${Date.now().toString(36)}`
  sheet.columns.push({ key, label: label || '', period: period || '', report_type: period ? '年报' : '', type: 'number' })
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
}

/** 改列标题（自由填写栏目） */
async function renameColumn(index: number, label: string) {
  if (!doc.value) return
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  const col = sheet.columns[index - 1]
  if (!col || col.label === label) return
  pushUndo('改列标题')
  col.label = label
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
}

// ---------- 工作表（多工作区） ----------

async function switchSheet(key: string) {
  if (!doc.value || key === activeSheet.value) return
  await api.updateTable(doc.value.id, { active: key })
  await loadDoc(doc.value.id)
}

/** 整簿保存（页签增删改都走这里） */
async function saveSheets(sheets: any[], active: string, label: string) {
  if (!doc.value) return
  pushUndo(label)
  await api.updateTable(doc.value.id, { sheets, active })
  await loadDoc(doc.value.id)
}

function currentSheetsPayload(): any[] {
  if (!doc.value) return []
  const active = activeSheet.value
  const full = doc.value.workbook?.sheets ?? []
  if (full.length) {
    // 用内存里的活动 sheet 覆盖对应槽位，其余工作表原样带回（避免整簿替换时丢数据）
    return full.map((s) =>
      s.key === active
        ? { key: s.key, name: s.name, columns: doc.value!.sheet.columns, rows: doc.value!.sheet.rows }
        : s,
    )
  }
  return [{ key: active || 's1', name: 'Sheet1', columns: doc.value.sheet.columns, rows: doc.value.sheet.rows }]
}

async function addSheet() {
  if (!doc.value) return
  const name = prompt('新工作表名称', `Sheet${sheetList.value.length + 1}`)
  if (!name) return
  const key = `s_${Date.now().toString(36)}`
  const blank = {
    key,
    name,
    columns: [
      { key: 'n1', label: '', period: '', report_type: '', type: 'text' },
      { key: 'n2', label: '', period: '', report_type: '', type: 'number' },
      { key: 'n3', label: '', period: '', report_type: '', type: 'number' },
    ],
    rows: Array.from({ length: 8 }, (_, i) => ({ key: `nr${i + 1}`, label: '', field: '', cells: {} })),
  }
  await saveSheets([...currentSheetsPayload(), blank], key, '新增工作表')
}

async function renameSheet() {
  if (!doc.value) return
  const cur = sheetList.value.find((s) => s.key === activeSheet.value)
  const name = prompt('重命名工作表', cur?.name ?? '')
  if (!name || name === cur?.name) return
  const sheets = currentSheetsPayload().map((s) => (s.key === activeSheet.value ? { ...s, name } : s))
  await saveSheets(sheets, activeSheet.value, '重命名工作表')
}

async function deleteSheet() {
  if (!doc.value) return
  if (sheetList.value.length <= 1) {
    error.value = '至少保留一个工作表'
    return
  }
  if (!confirm('删除当前工作表及其数据？')) return
  const rest = currentSheetsPayload().filter((s) => s.key !== activeSheet.value)
  await saveSheets(rest, rest[0]?.key ?? 's1', '删除工作表')
}

// ---------- 数据透视表 ----------

const pivotFieldList = computed(() => (doc.value ? pivotFields(doc.value.sheet as any) : []))

function openPivot() {
  if (!doc.value) return
  const fields = pivotFieldList.value
  pivotSpec.value = {
    rowField: '__label',
    colField: fields[1]?.key ?? '',
    valueField: fields[2]?.key ?? fields[1]?.key ?? '',
    agg: 'sum',
  }
  pivotSheetName.value = `透视表${sheetList.value.length}`
  refreshPivot()
  pivotOpen.value = true
}

function refreshPivot() {
  if (!doc.value) return
  pivotResult.value = computePivot(doc.value.sheet as any, pivotSpec.value)
}

/** 把透视结果插入为新工作表 */
async function insertPivotSheet() {
  if (!doc.value || !pivotResult.value) return
  const key = `s_${Date.now().toString(36)}`
  const sheet: any = pivotToSheet(pivotResult.value, pivotSpec.value, pivotSheetName.value)
  const payload = {
    key,
    name: pivotSheetName.value || '透视表',
    columns: sheet.columns,
    rows: sheet.rows,
  }
  await saveSheets([...currentSheetsPayload(), payload], key, '插入透视表')
  pivotOpen.value = false
  toast.value = `已插入工作表「${payload.name}」（${payload.rows.length} 行 × ${payload.columns.length} 列）`
  setTimeout(() => (toast.value = ''), 5000)
}

// ---------- 宏 ----------

function openMacros() {
  if (!doc.value) return
  const saved = (doc.value.macros ?? []) as Macro[]
  macroList.value = [...saved.map((m) => ({ ...m })), ...BUILTIN_MACROS.map((m) => ({ ...m }))]
  macroIndex.value = 0
  macroName.value = macroList.value[0]?.name ?? '新宏'
  macroCode.value = macroList.value[0]?.code ?? ''
  macroLogs.value = []
  macroError.value = ''
  macroOpen.value = true
}

function pickMacro(i: number) {
  const m = macroList.value[i]
  if (!m) return
  macroIndex.value = i
  macroName.value = m.name
  macroCode.value = m.code
  macroLogs.value = []
  macroError.value = ''
}

/** 运行宏：作用于当前工作表；先记快照以便撤销 */
async function runCurrentMacro() {
  if (!doc.value) return
  macroError.value = ''
  macroLogs.value = []
  const result = runMacro(macroCode.value, doc.value.sheet as any)
  if (result.error) {
    macroError.value = result.error
    return
  }
  pushUndo(`运行宏：${macroName.value}`)
  doc.value.sheet.columns = result.sheet.columns as any
  doc.value.sheet.rows = result.sheet.rows as any
  recalcFormulas()
  await api.updateTable(doc.value.id, { sheet: JSON.parse(JSON.stringify(doc.value.sheet)) })
  await loadDoc(doc.value.id)
  macroLogs.value = result.logs.length ? result.logs : [`宏执行完成，改动 ${result.changed} 个单元格`]
  toast.value = `宏「${macroName.value}」已执行（改动 ${result.changed} 处）`
  setTimeout(() => (toast.value = ''), 4000)
}

/** 把当前代码存成表格宏（随表格保存） */
async function saveCurrentMacro() {
  if (!doc.value) return
  const name = macroName.value.trim() || `宏${(doc.value.macros?.length ?? 0) + 1}`
  const saved = (doc.value.macros ?? []).filter((m) => m.name !== name)
  const next = [...saved, { name, code: macroCode.value, updated_at: new Date().toISOString() }]
  await api.updateTable(doc.value.id, { macros: next })
  doc.value.macros = next
  toast.value = `已保存宏「${name}」`
  setTimeout(() => (toast.value = ''), 3000)
}

async function deleteMacro() {
  if (!doc.value) return
  const saved = (doc.value.macros ?? []).filter((m) => m.name !== macroName.value)
  await api.updateTable(doc.value.id, { macros: saved })
  doc.value.macros = saved
  toast.value = `已删除宏「${macroName.value}」`
  setTimeout(() => (toast.value = ''), 3000)
}

/** 数字格式（当前列或整个表）：千分位/两位小数/百分比/整数/常规 */
async function setFormat(mode: string) {
  if (!doc.value) return
  pushUndo('设置格式')
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  for (const r of sheet.rows) {
    for (const cell of Object.values(r.cells ?? {}) as any[]) {
      if (typeof cell?.value === 'number') {
        if (mode === 'general') delete cell.format
        else cell.format = mode
      }
    }
  }
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
  toast.value = `数字格式：${mode}`
  setTimeout(() => (toast.value = ''), 2500)
}

async function runValidate() {
  if (!doc.value) return
  try {
    validation.value = await api.validateTable(doc.value.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function openPreview() {
  if (!doc.value) return
  try {
    preview.value = await api.previewIngest(doc.value.id)
    previewOpen.value = true
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function doIngest() {
  if (!doc.value) return
  saving.value = true
  try {
    const r = await api.ingestTable(doc.value.id, false)
    ingestNote.value = `新增 ${r.created.length} 期 · 更新 ${r.updated.length} 期 · 跳过 ${r.skipped.length} 期`
    if (r.conflicts.length) {
      ingestNote.value += `｜${r.conflicts.length} 期与公开数据冲突（未覆盖）`
    }
    previewOpen.value = false
    await loadDoc(doc.value.id)
    await loadList()
    toast.value = ingestNote.value
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
  setTimeout(() => (toast.value = ''), 6000)
}

async function remove(id: number) {
  if (!confirm('删除这张表格？已入库的数据不会被删除。')) return
  await api.deleteTable(id)
  if (doc.value?.id === id) doc.value = null
  await loadList()
}

// ---------- 图片识别导入（多模态读取 → 表格） ----------

/** 前端压缩后上传，再让后端读取并填入当前表格 */
async function importFromImage(file: File) {
  if (!doc.value) return
  readingBusy.value = true
  error.value = ''
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('读取图片失败'))
      fr.readAsDataURL(file)
    })
    const up = await api.uploadAttachment({
      filename: file.name,
      mime: file.type || 'image/png',
      data_base64: dataUrl,
      origin: 'paste',
    })
    const r = await api.readAttachment(up.attachment.id, { target: 'finance', table_id: doc.value.id })
    reading.value = r.reading
    readingOpen.value = true
    const written = r.fill?.written ?? 0
    toast.value = written
      ? `已识别并填入 ${written} 个科目（待确认）`
      : r.fill?.note || '识别完成，但没有可映射的科目'
    await loadDoc(doc.value.id)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    readingBusy.value = false
  }
}

function pickImage() {
  imageInput.value?.click()
}

function onPickImage(e: Event) {
  const el = e.target as HTMLInputElement
  const f = el.files?.[0]
  if (f) void importFromImage(f)
  el.value = ''
}

/** 确认全部模型识别结果（vision → user），确认后才允许入库 */
async function confirmVision() {
  if (!doc.value) return
  try {
    const r = await api.confirmTableCells(doc.value.id)
    toast.value = `已确认 ${r.confirmed} 个识别结果`
    await loadDoc(doc.value.id)
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 4000)
}

function openDoc(id: number) {
  openPanel('tables', { props: { tableId: id } })
}

watch(
  () => props.tableId,
  (id) => {
    if (id) loadDoc(id)
    else doc.value = null
  },
)

onMounted(async () => {
  await Promise.all([loadList(), loadMeta()])
  if (props.tableId) await loadDoc(props.tableId)
  window.addEventListener('keydown', onUndoKey)
})

onUnmounted(() => window.removeEventListener('keydown', onUndoKey))
</script>

<template>
  <div class="page">
    <!-- ============ 列表视图 ============ -->
    <template v-if="!doc">
      <div class="page-head">
        <div>
          <h2>财报表格</h2>
          <p class="page-sub">在线创建 / 编辑财报表格 · 勾稽校验后入库，参与评分与金融分析</p>
        </div>
        <div class="head-actions">
          <button class="btn ghost small" @click="newOpen = true">📋 新建表格</button>
          <button class="btn ghost small" @click="importOpen = true">📄 导入文件 / 粘贴</button>
          <button class="btn ghost small" @click="loadList">刷新</button>
        </div>
      </div>

      <p v-if="error" class="error-box">{{ error }}</p>

      <div class="card">
        <div v-if="!docs.length" class="empty">
          还没有表格。点「新建表格」选一套模板（利润表 / 资产负债表 / 现金流量表 / 关键指标表）开始录入，
          非上市企业也能因此进入金融分析。
        </div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>标题</th><th>企业</th><th>口径</th><th>期间</th><th>状态</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in docs" :key="t.id" class="clickable" @click="openDoc(t.id)">
              <td>
                <b>{{ t.title }}</b>
                <span class="badge">{{ t.columns }} 期 · {{ t.rows }} 科目</span>
              </td>
              <td>{{ t.enterprise ?? '—' }}</td>
              <td>{{ t.unit }} / {{ t.scope }}</td>
              <td>{{ t.period_type }}</td>
              <td>
                <span class="badge" :class="{ ok: t.status === 'ingested', warn: t.status === 'draft' }">
                  {{ t.status === 'ingested' ? '已入库' : t.status === 'confirmed' ? '已确认' : '草稿' }}
                </span>
              </td>
              <td class="right">
                <button class="btn ghost small" @click.stop="remove(t.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 编辑器视图 ============ -->
    <template v-else>
      <div class="page-head">
        <div>
          <h2>{{ doc.title }}</h2>
          <p class="page-sub">
            <span class="badge" :class="{ ok: doc.status === 'ingested', warn: doc.status === 'draft' }">{{ statusLabel }}</span>
            <span class="badge">v{{ doc.version }}</span>
            <span v-if="doc.enterprise_id" class="muted">已绑定企业</span>
            <span v-else class="badge warn">未绑定企业</span>
          </p>
        </div>
        <div class="head-actions">
          <button class="btn ghost small" @click="doc = null; loadList()">← 返回列表</button>
          <input ref="imageInput" type="file" accept="image/*" hidden @change="onPickImage" />
          <button class="btn ghost small" :disabled="readingBusy" title="上传财报截图，自动识别并填入本表" @click="pickImage">
            {{ readingBusy ? '识别中…' : '📷 从图片识别' }}
          </button>
          <button class="btn primary small" :disabled="validation?.ok !== true || saving" @click="openPreview">
            {{ validation?.ok ? '入库…' : '校验通过后可入库' }}
          </button>
        </div>
      </div>

      <p v-if="toast" class="toast">
        {{ toast }}
        <button
          v-if="doc?.enterprise_id"
          class="btn ghost small"
          title="用刚入库的数据跑金融分析（KPI / 杜邦 / Z·F·M）"
          @click="openPanel('finance', { props: { enterpriseId: doc.enterprise_id }, title: '金融分析', dock: 'right' })"
        >
          📈 查看金融分析
        </button>
      </p>
      <p v-if="error" class="error-box">{{ error }}</p>

      <!-- 表头元数据：单位/口径/期间，直接决定数值量级 -->
      <div class="card meta">
        <label>企业
          <select
            :value="doc.enterprise_id ?? ''"
            @change="saveMeta({ enterprise_id: Number(($event.target as HTMLSelectElement).value) || null })"
          >
            <option value="">未绑定</option>
            <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
        <label>单位
          <select :value="doc.unit" @change="saveMeta({ unit: ($event.target as HTMLSelectElement).value })">
            <option>万元</option><option>元</option><option>亿元</option>
          </select>
        </label>
        <label>口径
          <select :value="doc.scope" @change="saveMeta({ scope: ($event.target as HTMLSelectElement).value })">
            <option>合并报表</option><option>母公司</option>
          </select>
        </label>
        <label>报告类型
          <select :value="doc.period_type" @change="saveMeta({ period_type: ($event.target as HTMLSelectElement).value })">
            <option>年报</option><option>中报</option><option>季报</option>
          </select>
        </label>
        <span class="tip">提示：可直接从 Excel 复制区域，点击起始单元格后 Ctrl+V 批量粘贴</span>
      </div>

      <!-- 校验横幅 -->
      <div v-if="validation" class="card banner" :class="validation.ok ? 'pass' : 'fail'">
        <div class="banner-head">
          <b>{{ validation.ok ? '✅ 勾稽校验通过' : `⛔ 校验未通过：${validation.errors} 个错误` }}</b>
          <span v-if="validation.warnings" class="muted">· {{ validation.warnings }} 条提示</span>
          <button
            v-if="hasVisionCells"
            class="btn ghost small confirm-btn"
            title="核对后确认：确认前不允许入库"
            @click="confirmVision"
          >
            ✔ 确认识别结果（{{ visionCellCount }} 格）
          </button>
        </div>
        <ul v-if="errorIssues.length" class="issues">
          <li v-for="(i, idx) in errorIssues.slice(0, 6)" :key="idx">⛔ {{ i.message }}</li>
        </ul>
        <ul v-if="otherIssues.length" class="issues muted">
          <li v-for="(i, idx) in otherIssues" :key="idx">· {{ i.message }}</li>
        </ul>
      </div>

      <!-- 工具栏（Excel 式操作） -->
      <div class="card toolbar">
        <span class="tb-group">
          <button class="btn ghost small" :disabled="!undoStack.length" :title="undoStack.length ? `撤销：${undoStack[undoStack.length - 1].label}（Ctrl+Z）` : '无可撤销操作'" @click="undo">↶</button>
          <button class="btn ghost small" :disabled="!redoStack.length" title="重做（Ctrl+Shift+Z / Ctrl+Y）" @click="redo">↷</button>
        </span>
        <span class="tb-sep"></span>
        <span class="tb-group">
          <button class="btn ghost small" title="在选区插入行" @click="onStructure({ action: 'insert-row', index: selection.rows || 1 })">插入行</button>
          <button class="btn ghost small" title="删除选中行" @click="onStructure({ action: 'delete-row', index: selection.rows || 1 })">删除行</button>
          <button class="btn ghost small" @click="addColumn">＋ 期间</button>
          <button class="btn ghost small" :disabled="columns.length <= 1" title="删除选中列" @click="onStructure({ action: 'delete-col', index: selection.cols || 1 })">删除列</button>
        </span>
        <span class="tb-sep"></span>
        <span class="tb-group">
          <button class="btn ghost small" title="当前列升序" @click="onStructure({ action: 'sort', index: selection.cols || 1, asc: true })">↑ 排序</button>
          <button class="btn ghost small" title="当前列降序" @click="onStructure({ action: 'sort', index: selection.cols || 1, asc: false })">↓ 排序</button>
        </span>
        <span class="tb-sep"></span>
        <span class="tb-group">
          <button class="btn ghost small" title="千分位" @click="setFormat('money')">1,234.00</button>
          <button class="btn ghost small" title="整数" @click="setFormat('int')">1,234</button>
          <button class="btn ghost small" title="百分比" @click="setFormat('percent')">%</button>
          <button class="btn ghost small" title="常规" @click="setFormat('general')">常规</button>
        </span>
        <span class="tb-sep"></span>
        <span class="tb-group">
          <button class="btn ghost small" title="数据透视表：按行/列字段分组汇总" @click="openPivot">⊞ 透视表</button>
          <button class="btn ghost small" title="宏：用一小段脚本批量处理本表" @click="openMacros">⚙ 宏</button>
        </span>
        <span class="tb-sep"></span>
        <span class="tb-fx">
          <i>ƒx</i>
          <span class="cell-ref">{{ activeRef || '—' }}</span>
          <input
            class="fx-input"
            placeholder="输入公式，如 =B3/B2*100 或 =SUM(B2:B5)"
            :value="activeFormula"
            @keydown.enter="applyFormulaFromBar(($event.target as HTMLInputElement).value)"
          />
        </span>
      </div>

      <!-- 表格本体（Excel 式栅格：区域选择 / 公式 / 复制粘贴 / 填充 / 行列操作） -->
      <div class="card grid-wrap">
        <SpreadsheetGrid
          ref="gridRef"
          :columns="columns as any"
          :rows="rows as any"
          :issues="cellIssues"
          @change="onCellsChange"
          @structure="onStructure"
          @rename-row="(p) => renameRow(rows[p.index - 1]?.key ?? '', p.label)"
          @rename-column="(p) => renameColumn(p.index, p.label)"
          @set-period="(p) => setColumnPeriod(columns[p.index - 1]?.key ?? '', { period: p.period })"
          @select="onSelect"
        />
        <p class="hint muted small">
          双击或直接输入编辑 · Enter/Tab 移动 · Shift+点击或拖拽选区 · Ctrl+C/X/V 复制粘贴（与 Excel 互通）·
          Ctrl+D 向下填充 · Ctrl+R 向右填充 · Delete 清空 · Ctrl+Z/Y 撤销重做
        </p>
      </div>

      <!-- 工作表页签（多工作区） -->
      <div class="card sheet-tabs">
        <button
          v-for="s in sheetList"
          :key="s.key"
          class="sheet-tab"
          :class="{ active: s.key === activeSheet }"
          :title="`${s.name} · ${s.rows} 行 × ${s.columns} 列`"
          @click="switchSheet(s.key)"
        >
          {{ s.name }}
        </button>
        <span class="tabs-tools">
          <button class="btn ghost small" title="新增工作表" @click="addSheet">＋</button>
          <button class="btn ghost small" title="重命名当前工作表" @click="renameSheet">✎</button>
          <button class="btn ghost small" :disabled="sheetList.length <= 1" title="删除当前工作表" @click="deleteSheet">🗑</button>
        </span>
      </div>

      <p class="muted small" v-if="doc.note">备注：{{ doc.note }}</p>
    </template>

    <!-- 新建弹窗 -->
    <div v-if="newOpen" class="modal" @click.self="newOpen = false">
      <div class="modal-card">
        <h3>新建表格</h3>
        <p class="muted small">
          默认给一张**空白表格**：列标题、行标题都留空，自己填就行（不限定财报模板）。
          需要现成科目行时再选下面的模板。
        </p>
        <label>起始内容
          <select v-model="form.kind">
            <option value="blank">空白表格（推荐）</option>
            <option v-for="t in templates" :key="t.kind" :value="t.kind">{{ t.title }}（模板）</option>
          </select>
        </label>
        <label>企业（可留空，之后再绑定）
          <select v-model="form.enterprise_id">
            <option :value="null">未绑定</option>
            <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
        <label>标题<input v-model="form.title" placeholder="如：XX 公司 2024-2025 关键指标" /></label>
        <label v-if="form.kind !== 'blank'">期间（逗号分隔）
          <input :value="form.periods.join(',')" @change="form.periods = ($event.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean)" />
        </label>
        <div class="row">
          <label>单位
            <select v-model="form.unit"><option>万元</option><option>元</option><option>亿元</option></select>
          </label>
          <label>口径
            <select v-model="form.scope"><option>合并报表</option><option>母公司</option></select>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost small" @click="newOpen = false">取消</button>
          <button class="btn primary small" :disabled="saving" @click="create">创建</button>
        </div>
      </div>
    </div>

    <!-- 数据透视表弹窗 -->
    <div v-if="pivotOpen" class="modal" @click.self="pivotOpen = false">
      <div class="modal-card wide">
        <h3>⊞ 数据透视表</h3>
        <p class="muted small">
          把当前工作表当成数据表：选「行字段 / 列字段 / 值字段」，实时预览分组汇总结果，可插入为新工作表。
          长表（如 年度 | 科目 | 数值）选行=科目、列=年度、值=数值 即可得到矩阵。
        </p>
        <div class="row">
          <label>行字段
            <select v-model="pivotSpec.rowField" @change="refreshPivot">
              <option v-for="f in pivotFieldList" :key="f.key" :value="f.key">{{ f.label }}</option>
            </select>
          </label>
          <label>列字段
            <select v-model="pivotSpec.colField" @change="refreshPivot">
              <option v-for="f in pivotFieldList" :key="f.key" :value="f.key">{{ f.label }}</option>
            </select>
          </label>
          <label>值字段
            <select v-model="pivotSpec.valueField" @change="refreshPivot">
              <option v-for="f in pivotFieldList" :key="f.key" :value="f.key">{{ f.label }}</option>
            </select>
          </label>
          <label>聚合
            <select v-model="pivotSpec.agg" @change="refreshPivot">
              <option value="sum">求和</option>
              <option value="count">计数</option>
              <option value="avg">平均</option>
              <option value="max">最大</option>
              <option value="min">最小</option>
            </select>
          </label>
        </div>
        <div v-if="pivotResult" class="pivot-wrap">
          <table class="tbl small pivot">
            <thead>
              <tr>
                <th>{{ pivotSpec.rowField === '__label' ? '行标题' : '行' }}</th>
                <th v-for="c in pivotResult.colLabels" :key="c">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, ri) in pivotResult.rowLabels" :key="r">
                <td>{{ r }}</td>
                <td v-for="(c, ci) in pivotResult.colLabels" :key="c">
                  {{ pivotResult.matrix[ri][ci] === null ? '—' : pivotResult.matrix[ri][ci] }}
                </td>
              </tr>
              <tr class="total">
                <td>合计（{{ pivotSpec.agg === 'count' ? '计数' : pivotSpec.agg }}）</td>
                <td :colspan="pivotResult.colLabels.length">{{ pivotResult.total ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted small">
            扫描 {{ pivotResult.scannedRows }} 行 · {{ pivotResult.rowLabels.length }} 个行分组 ·
            {{ pivotResult.colLabels.length }} 个列分组
            <span v-if="pivotResult.warnings.length"> · {{ pivotResult.warnings.join('；') }}</span>
          </p>
        </div>
        <label>新工作表名称<input v-model="pivotSheetName" /></label>
        <div class="modal-actions">
          <button class="btn ghost small" @click="pivotOpen = false">取消</button>
          <button class="btn primary small" @click="insertPivotSheet">插入为新工作表</button>
        </div>
      </div>
    </div>

    <!-- 宏弹窗 -->
    <div v-if="macroOpen" class="modal" @click.self="macroOpen = false">
      <div class="modal-card wide">
        <h3>⚙ 表格宏</h3>
        <p class="muted small">
          用一小段 JS 批量处理当前工作表（增删行列、改值、算合计、换算单位…）。运行前会自动记录快照，可 Ctrl+Z 撤销。
          注：这是脚本宏，不是 Excel VBA——不支持 VBA 语法与录制。
        </p>
        <div class="macro-layout">
          <div class="macro-list">
            <div
              v-for="(m, i) in macroList"
              :key="m.name + i"
              class="macro-item"
              :class="{ active: i === macroIndex }"
              @click="pickMacro(i)"
            >
              <span>{{ m.builtin ? '内置' : '我的' }}</span>
              <b>{{ m.name }}</b>
            </div>
          </div>
          <div class="macro-editor">
            <label>宏名称<input v-model="macroName" /></label>
            <textarea v-model="macroCode" rows="12" class="code-box" spellcheck="false"></textarea>
            <p class="muted small">
              可用：<code>sheet.columns</code> / <code>sheet.rows</code> · <code>num(v)</code> ·
              <code>cell(行,列)</code> · <code>set(行,列,值)</code> · <code>addColumn(label)</code> ·
              <code>addRow(label)</code> · <code>colValues(列)</code> · <code>log(...)</code>
            </p>
            <p v-if="macroError" class="error-box">宏执行失败：{{ macroError }}</p>
            <ul v-if="macroLogs.length" class="macro-logs">
              <li v-for="(l, i) in macroLogs" :key="i">{{ l }}</li>
            </ul>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost small" @click="deleteMacro">删除此宏</button>
          <button class="btn ghost small" @click="saveCurrentMacro">保存到表格</button>
          <button class="btn primary small" @click="runCurrentMacro">▶ 运行宏</button>
        </div>
      </div>
    </div>

    <!-- 导入（文件 / 粘贴）弹窗 -->
    <div v-if="importOpen" class="modal" @click.self="importOpen = false">
      <div class="modal-card wide">
        <h3>导入表格（确定性解析，不经模型）</h3>
        <p class="muted small">
          支持 Excel（.xlsx/.xls）与 CSV；也可以直接从 Excel 复制整块区域粘贴到下面。
          表头含年份 → 识别为「列=期间」；含「年度/科目/数值」三列 → 自动透视。
        </p>
        <div class="row">
          <label>绑定企业
            <select v-model="importForm.enterprise_id">
              <option :value="null">未绑定</option>
              <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
          <label>标题<input v-model="importForm.title" placeholder="留空则用文件名" /></label>
        </div>
        <div class="row">
          <label>单位（留空则从表头自动识别）
            <select v-model="importForm.unit"><option value="">自动</option><option>万元</option><option>元</option><option>亿元</option></select>
          </label>
          <label>口径
            <select v-model="importForm.scope"><option value="">自动</option><option>合并报表</option><option>母公司</option></select>
          </label>
        </div>
        <input ref="sheetInput" type="file" accept=".csv,.xlsx,.xls" hidden @change="onPickSheet" />
        <button class="btn ghost small" :disabled="importBusy" @click="pickSheetFile">📎 选择文件（csv / xlsx）</button>
        <label>或粘贴表格内容
          <textarea v-model="importForm.text" rows="6" class="paste-box" placeholder="科目&#9;2025年报&#9;2024年报&#10;营业总收入&#9;128600&#9;96300"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost small" @click="importOpen = false">取消</button>
          <button class="btn primary small" :disabled="importBusy || !importForm.text.trim()" @click="importFromText">
            {{ importBusy ? '解析中…' : '解析并建表' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 识别结果弹窗 -->
    <div v-if="readingOpen" class="modal" @click.self="readingOpen = false">
      <div class="modal-card">
        <h3>📷 图片识别结果</h3>
        <p class="muted small">
          {{ reading?.title || '（未给出标题）' }}
          <span v-if="reading?.meta?.unit"> · 单位 {{ reading.meta.unit }}</span>
          <span v-if="reading?.meta?.period"> · 期间 {{ reading.meta.period }}</span>
          <span v-if="reading?.confidence"> · 最低置信度 {{ reading.confidence }}</span>
        </p>
        <table class="tbl small">
          <thead><tr><th>科目</th><th>数值</th><th>映射</th><th>置信度</th></tr></thead>
          <tbody>
            <tr v-for="(f, i) in reading?.fields ?? []" :key="i">
              <td>{{ f.label }}</td>
              <td>{{ f.value }}{{ f.unit }}</td>
              <td>
                <span class="badge" :class="{ ok: !!f.field, warn: !f.field }">
                  {{ f.field || '未映射' }}
                </span>
              </td>
              <td>{{ Math.round((f.confidence ?? 0) * 100) }}%</td>
            </tr>
          </tbody>
        </table>
        <p v-if="reading?.notes?.length" class="muted small">
          不确定点：{{ reading.notes.join('；') }}
        </p>
        <p class="muted small">
          已填入当前期间的对应科目，标记为「待确认」——请在表格中核对数字后点「确认识别结果」，确认前无法入库。
        </p>
        <div class="modal-actions">
          <button class="btn ghost small" @click="readingOpen = false">知道了</button>
          <button class="btn primary small" @click="readingOpen = false; confirmVision()">全部确认</button>
        </div>
      </div>
    </div>

    <!-- 入库确认弹窗 -->
    <div v-if="previewOpen" class="modal" @click.self="previewOpen = false">
      <div class="modal-card">
        <h3>入库确认</h3>
        <p class="muted small">
          单位 {{ doc?.unit }} · 口径 {{ doc?.scope }} · 来源将标记为「用户提供」，不会覆盖已有的公开信源数据。
        </p>
        <table class="tbl small">
          <thead><tr><th>期间</th><th>报告类型</th><th>动作</th></tr></thead>
          <tbody>
            <tr v-for="(p, i) in preview?.plan ?? []" :key="i">
              <td>{{ p.period }}</td>
              <td>{{ p.report_type }}</td>
              <td>
                <span class="badge" :class="{ ok: p.action === 'create', warn: p.action === 'conflict' }">
                  {{ p.action === 'create' ? '新增' : p.action === 'update' ? '更新' : '与公开数据冲突（跳过）' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn ghost small" @click="previewOpen = false">取消</button>
          <button class="btn primary small" :disabled="saving" @click="doIngest">确认入库</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head .badge { margin-right: 6px; }
.meta { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
.meta label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-sub); }
.meta select { font-family: inherit; font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--text); }
.meta .tip { margin-left: auto; font-size: 11px; color: var(--text-sub); }

.banner.pass { border-left: 3px solid var(--ok, #16a34a); }
.banner.fail { border-left: 3px solid var(--danger, #dc2626); }
.banner-head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
.issues { margin: 6px 0 0; padding-left: 4px; list-style: none; font-size: 12px; line-height: 1.7; }
.issues li { color: var(--danger, #dc2626); }
.issues.muted li { color: var(--text-sub); }

.grid-wrap { overflow: auto; padding: 0; }
.grid { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12.5px; }
.grid th, .grid td { border-bottom: 1px solid var(--border-soft); border-right: 1px solid var(--border-soft); padding: 4px 8px; text-align: right; }
.grid thead th { position: sticky; top: 0; background: var(--bg-elev); z-index: 2; font-weight: 600; }
.grid .corner, .grid .row-head { text-align: left; position: sticky; left: 0; background: var(--card); z-index: 1; min-width: 150px; }
.grid thead .corner { z-index: 3; }
.col-head .col-sub { display: flex; gap: 4px; align-items: center; justify-content: flex-end; margin-top: 2px; }
.col-head .col-sub i, .acts i { font-style: normal; cursor: pointer; color: var(--text-sub); font-size: 10.5px; }
.col-head .col-sub i:hover, .acts i:hover { color: var(--danger, #dc2626); }
.cell { cursor: cell; min-width: 96px; position: relative; }
.cell:hover { background: var(--hover); }
.cell.empty { color: var(--text-sub); }
.cell.err { background: rgba(220, 38, 38, 0.1); box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.4); }
.cell.warn { background: rgba(234, 179, 8, 0.12); }
.cell-input { width: 100%; text-align: right; border: 1px solid var(--primary); border-radius: 4px; font-family: inherit; font-size: 12.5px; padding: 1px 4px; background: var(--card); color: var(--text); }
.mini { width: 100%; border: 1px solid transparent; background: transparent; color: inherit; font-family: inherit; font-size: 12.5px; padding: 2px 4px; border-radius: 4px; }
.mini:hover { border-color: var(--border); }
.mini.label { font-weight: 600; }
.mapped { font-size: 9.5px; color: var(--ok, #16a34a); border: 1px solid currentColor; border-radius: 4px; padding: 0 3px; margin-left: 4px; }
.src.vision { position: absolute; top: 2px; left: 3px; font-size: 9px; color: #b45309; }
.acts { width: 26px; text-align: center; }

.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border-soft); text-align: left; }
.tbl tr.clickable { cursor: pointer; }
.tbl tr.clickable:hover { background: var(--hover); }
.tbl .right { text-align: right; }

.badge { font-size: 10.5px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; margin-left: 4px; color: var(--text-sub); }
.badge.ok { color: var(--ok, #16a34a); border-color: currentColor; }
.badge.warn { color: #b45309; border-color: currentColor; }
.muted { color: var(--text-sub); }
.small { font-size: 11.5px; }

.modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; width: min(520px, 92vw); display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow); }
.modal-card.wide { width: min(680px, 94vw); }
.modal-card textarea.paste-box { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; resize: vertical; }

/* 工作表页签 */
.sheet-tabs { display: flex; align-items: center; gap: 4px; padding: 4px 8px; flex-wrap: wrap; }
.sheet-tab {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text-sub);
  border-radius: 7px 7px 0 0;
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.sheet-tab:hover { color: var(--text); }
.sheet-tab.active { background: var(--card); color: var(--text); font-weight: 600; border-bottom-color: var(--card); }
.tabs-tools { margin-left: auto; display: inline-flex; gap: 4px; }

/* 透视表预览 */
.pivot-wrap { max-height: 320px; overflow: auto; border: 1px solid var(--border-soft); border-radius: 8px; }
table.pivot { width: 100%; border-collapse: collapse; }
table.pivot th, table.pivot td { border-bottom: 1px solid var(--border-soft); padding: 4px 8px; text-align: right; }
table.pivot th:first-child, table.pivot td:first-child { text-align: left; position: sticky; left: 0; background: var(--card); }
table.pivot thead th { position: sticky; top: 0; background: var(--bg-elev); z-index: 2; }
table.pivot tr.total td { font-weight: 600; background: var(--bg-elev); text-align: left; }

/* 宏编辑器 */
.macro-layout { display: flex; gap: 12px; min-height: 260px; }
.macro-list { width: 210px; display: flex; flex-direction: column; gap: 3px; max-height: 340px; overflow: auto; }
.macro-item { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.macro-item:hover { background: var(--hover); }
.macro-item.active { border-color: var(--primary); background: var(--bg-elev); }
.macro-item span { font-size: 9.5px; color: var(--text-sub); }
.macro-item b { font-size: 12px; font-weight: 600; }
.macro-editor { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
textarea.code-box {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
  color: var(--text);
  padding: 8px 10px;
  resize: vertical;
}
.macro-logs { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--text-sub); max-height: 90px; overflow: auto; }
.modal-card h3 { margin: 0; font-size: 15px; }
.modal-card label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-sub); }
.modal-card input, .modal-card select { font-family: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--text); }
.modal-card .row { display: flex; gap: 10px; }
.modal-card .row label { flex: 1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>

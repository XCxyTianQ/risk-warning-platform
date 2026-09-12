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
import { computed, onMounted, ref, watch } from 'vue'

import { api, type TableDoc, type TableIssue, type TableRow, type TableValidation } from '../api'
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

// 图片识别导入
const imageInput = ref<HTMLInputElement | null>(null)
const reading = ref<import('../api').Reading | null>(null)
const readingOpen = ref(false)
const readingBusy = ref(false)

// 新建表
const newOpen = ref(false)
const enterprises = ref<{ id: number; name: string }[]>([])
const templates = ref<{ kind: string; title: string }[]>([])
const form = ref({
  enterprise_id: null as number | null,
  title: '',
  kind: 'kpi',
  periods: [`${CURRENT_YEAR}`, `${CURRENT_YEAR - 1}`],
  unit: '万元',
  scope: '合并报表',
})

// 入库
const previewOpen = ref(false)
const preview = ref<{ plan: { period: string; report_type: string; action: string; existing_source: string | null }[] } | null>(null)
const ingestNote = ref('')

const editing = ref<{ row: string; col: string } | null>(null)
const editValue = ref('')

const columns = computed(() => doc.value?.sheet.columns ?? [])
const rows = computed(() => doc.value?.sheet.rows ?? [])
const issueMap = computed(() => {
  const m = new Map<string, TableIssue>()
  for (const i of validation.value?.issues ?? []) {
    if (i.row && i.col) m.set(`${i.row}:${i.col}`, i)
  }
  return m
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

function cellText(rowKey: string, colKey: string): string {
  const cell = rows.value.find((r) => r.key === rowKey)?.cells?.[colKey]
  if (!cell) return ''
  const v = cell.value
  if (v === null || v === undefined) return ''
  return String(v)
}

function cellSource(rowKey: string, colKey: string): string {
  return rows.value.find((r) => r.key === rowKey)?.cells?.[colKey]?.source ?? ''
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

async function persistCell(rowKey: string, colKey: string, value: any) {
  if (!doc.value) return
  try {
    await api.writeTableCells(doc.value.id, { row: rowKey, col: colKey, value, source: 'user' })
    // 局部更新，避免整表重载导致光标丢失
    const r = doc.value.sheet.rows.find((x) => x.key === rowKey)
    if (r) {
      if (value === null || value === '') delete r.cells[colKey]
      else r.cells[colKey] = { value: Number(value), source: 'user', confidence: 1 }
    }
    await runValidate()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function startEdit(rowKey: string, colKey: string) {
  editing.value = { row: rowKey, col: colKey }
  editValue.value = cellText(rowKey, colKey)
}

async function commitEdit() {
  if (!editing.value) return
  const { row, col } = editing.value
  const raw = editValue.value.trim()
  editing.value = null
  await persistCell(row, col, raw === '' ? null : Number(raw.replace(/,/g, '')))
}

function onEditKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitEdit()
  } else if (e.key === 'Escape') {
    editing.value = null
  }
}

/** 从 Excel 粘贴一块区域：按 TSV 解析，从当前单元格起铺开 */
async function onPaste(e: ClipboardEvent, rowKey: string, colKey: string) {
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text.trim() || !doc.value) return
  e.preventDefault()
  const grid = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => line.split('\t').map((c) => c.trim().replace(/,/g, '')))
  try {
    await api.writeTableCells(doc.value.id, {
      row: rowKey,
      col: colKey,
      values: grid,
      source: 'paste',
    })
    toast.value = `已粘贴 ${grid.length} 行 × ${grid[0]?.length ?? 0} 列`
    await loadDoc(doc.value.id)
  } catch (err) {
    error.value = (err as Error).message
  }
  setTimeout(() => (toast.value = ''), 4000)
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

async function addRow() {
  if (!doc.value) return
  const n = rows.value.length + 1
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  sheet.rows.push({ key: `r${n}_${Date.now().toString(36)}`, label: '新科目', field: '', cells: {} })
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
}

async function removeRow(rowKey: string) {
  if (!doc.value) return
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  sheet.rows = sheet.rows.filter((r: any) => r.key !== rowKey)
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
}

async function addColumn() {
  if (!doc.value) return
  const period = prompt('新增期间的年份（如 2026）', String(CURRENT_YEAR))
  if (!period) return
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  const key = `c${sheet.columns.length + 1}_${Date.now().toString(36)}`
  sheet.columns.push({ key, label: `${period}年报`, period, report_type: '年报', type: 'number' })
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
}

async function removeColumn(colKey: string) {
  if (!doc.value || columns.value.length <= 1) return
  if (!confirm('删除该期间列及其数据？')) return
  const sheet = JSON.parse(JSON.stringify(doc.value.sheet))
  sheet.columns = sheet.columns.filter((c: any) => c.key !== colKey)
  for (const r of sheet.rows) delete r.cells?.[colKey]
  await api.updateTable(doc.value.id, { sheet })
  await loadDoc(doc.value.id)
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
})
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
          <button class="btn primary small" @click="newOpen = true">＋ 新建表格</button>
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
          <button class="btn ghost small" @click="addRow">＋ 行</button>
          <button class="btn ghost small" @click="addColumn">＋ 期间</button>
          <button class="btn primary small" :disabled="validation?.ok !== true || saving" @click="openPreview">
            {{ validation?.ok ? '入库…' : '校验通过后可入库' }}
          </button>
        </div>
      </div>

      <p v-if="toast" class="toast">{{ toast }}</p>
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

      <!-- 表格本体 -->
      <div class="card grid-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="corner">科目</th>
              <th v-for="c in columns" :key="c.key" class="col-head">
                <div>{{ c.label }}</div>
                <div class="col-sub">
                  <input
                    class="mini"
                    :value="c.period"
                    @change="setColumnPeriod(c.key, { period: ($event.target as HTMLInputElement).value })"
                  />
                  <i title="删除该期间" @click="removeColumn(c.key)">✕</i>
                </div>
              </th>
              <th class="acts"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.key">
              <th class="row-head">
                <input
                  class="mini label"
                  :value="r.label"
                  @change="renameRow(r.key, ($event.target as HTMLInputElement).value)"
                />
                <span v-if="r.field" class="mapped" :title="`已映射到引擎字段 ${r.field}`">已映射</span>
              </th>
              <td
                v-for="c in columns"
                :key="c.key"
                class="cell"
                tabindex="0"
                :class="{
                  err: issueMap.get(`${r.key}:${c.key}`)?.level === 'error',
                  warn: issueMap.get(`${r.key}:${c.key}`)?.level === 'warn',
                  empty: !cellText(r.key, c.key),
                }"
                @click="startEdit(r.key, c.key)"
                @paste="onPaste($event, r.key, c.key)"
                :title="issueMap.get(`${r.key}:${c.key}`)?.message ?? (cellSource(r.key, c.key) === 'vision' ? '模型识别，待确认' : '')"
              >
                <input
                  v-if="editing && editing.row === r.key && editing.col === c.key"
                  v-model="editValue"
                  class="cell-input"
                  autofocus
                  @keydown="onEditKey"
                  @blur="commitEdit"
                />
                <span v-else>{{ cellText(r.key, c.key) || '—' }}</span>
                <i v-if="cellSource(r.key, c.key) === 'vision'" class="src vision" title="模型识别结果，请核对">AI</i>
              </td>
              <td class="acts">
                <i title="删除该行" @click="removeRow(r.key)">✕</i>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="muted small" v-if="doc.note">备注：{{ doc.note }}</p>
    </template>

    <!-- 新建弹窗 -->
    <div v-if="newOpen" class="modal" @click.self="newOpen = false">
      <div class="modal-card">
        <h3>新建财报表格</h3>
        <label>模板
          <select v-model="form.kind">
            <option v-for="t in templates" :key="t.kind" :value="t.kind">{{ t.title }}</option>
          </select>
        </label>
        <label>企业（可留空，之后再绑定）
          <select v-model="form.enterprise_id">
            <option :value="null">未绑定</option>
            <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
        <label>标题<input v-model="form.title" placeholder="如：XX 公司 2024-2025 关键指标" /></label>
        <label>期间（逗号分隔）
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
.modal-card h3 { margin: 0; font-size: 15px; }
.modal-card label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-sub); }
.modal-card input, .modal-card select { font-family: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--text); }
.modal-card .row { display: flex; gap: 10px; }
.modal-card .row label { flex: 1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { api, fmtTime, levelOf, type AlertRow } from '../api'
import { openPanel } from '../workspace/store'

const items = ref<AlertRow[]>([])
const summary = ref<{ total: number; pending: number; handling: number; by_status: Record<string, number> } | null>(null)
const loading = ref(true)
const error = ref('')
const toast = ref('')

const statusFilter = ref('all')
const levelFilter = ref('all')
const active = ref<AlertRow | null>(null)
const handlerName = ref(localStorage.getItem('rw-handler') || '')
const noteText = ref('')
const acting = ref(false)

const STATUSES = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'handling', label: '处理中' },
  { key: 'resolved', label: '已处置' },
  { key: 'ignored', label: '已忽略' },
]

const filtered = computed(() =>
  items.value.filter(
    (a) => (statusFilter.value === 'all' || a.status === statusFilter.value) && (levelFilter.value === 'all' || a.level === levelFilter.value),
  ),
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [list, sum] = await Promise.all([api.alerts(), api.alertSummary()])
    items.value = list.items
    summary.value = sum
    if (active.value) active.value = items.value.find((x) => x.id === active.value!.id) ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function generate() {
  try {
    const r = await api.generateAlerts()
    toast.value = `已生成 ${r.created ?? 0} 条预警（跳过重复 ${r.skipped ?? 0} 条）`
    setTimeout(() => (toast.value = ''), 5000)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function openDetail(a: AlertRow) {
  active.value = a
  noteText.value = ''
}

async function act(action: string) {
  if (!active.value || acting.value) return
  if (!handlerName.value.trim()) {
    error.value = '请先填写处理人姓名'
    return
  }
  acting.value = true
  error.value = ''
  try {
    localStorage.setItem('rw-handler', handlerName.value.trim())
    await api.handleAlert(active.value.id, action, handlerName.value.trim(), noteText.value.trim())
    noteText.value = ''
    toast.value = '处置已记录'
    setTimeout(() => (toast.value = ''), 3000)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    acting.value = false
  }
}

function downloadReport(a: AlertRow) {
  window.open(api.alertReportUrl(a.id), '_blank')
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>预警中心</h2>
        <p class="page-sub">评分触发的预警工单 · 处置闭环（待处理 → 处理中 → 已处置/已忽略）</p>
      </div>
      <div class="head-actions">
        <button class="btn ghost small" @click="generate">⚡ 生成预警</button>
        <button class="btn ghost small" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="toast" class="toast">{{ toast }}</p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="stat-grid">
      <div class="stat-card tone-red">
        <div class="stat-icon">📋</div>
        <div>
          <div class="stat-value">{{ summary?.pending ?? 0 }}</div>
          <div class="stat-label">待处理</div>
        </div>
      </div>
      <div class="stat-card tone-orange">
        <div class="stat-icon">🛠️</div>
        <div>
          <div class="stat-value">{{ summary?.handling ?? 0 }}</div>
          <div class="stat-label">处理中</div>
        </div>
      </div>
      <div class="stat-card tone-cyan">
        <div class="stat-icon">✅</div>
        <div>
          <div class="stat-value">{{ summary?.by_status?.resolved ?? 0 }}</div>
          <div class="stat-label">已处置</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">Σ</div>
        <div>
          <div class="stat-value">{{ summary?.total ?? 0 }}</div>
          <div class="stat-label">预警总数</div>
        </div>
      </div>
    </div>

    <div class="toolbar">
      <div class="chips">
        <button v-for="s in STATUSES" :key="s.key" class="chip-btn" :class="{ active: statusFilter === s.key }" @click="statusFilter = s.key">
          {{ s.label }}
          <template v-if="s.key !== 'all'"> {{ summary?.by_status?.[s.key] ?? 0 }}</template>
        </button>
      </div>
      <div class="chips">
        <button class="chip-btn" :class="{ active: levelFilter === 'all' }" @click="levelFilter = 'all'">全部等级</button>
        <button v-for="lv in ['red', 'orange', 'yellow']" :key="lv" class="chip-btn" :class="{ active: levelFilter === lv }" @click="levelFilter = lv">
          <i class="dot" :style="{ background: levelOf(lv).color }"></i>{{ levelOf(lv).label }}
        </button>
      </div>
    </div>

    <div class="alert-layout">
      <!-- 列表 -->
      <div class="card list-card">
        <div v-if="!filtered.length && !loading" class="empty">暂无预警——点击「⚡ 生成预警」按当前评分生成</div>
        <div
          v-for="a in filtered"
          :key="a.id"
          class="alert-item"
          :class="{ active: active?.id === a.id }"
          @click="openDetail(a)"
        >
          <span class="lv-bar" :style="{ background: levelOf(a.level).color }"></span>
          <div class="ai-main">
            <div class="ai-title">{{ a.title }}</div>
            <div class="ai-meta">
              <a class="link" @click.stop="openPanel('profile', { props: { enterpriseId: a.enterprise_id }, title: a.enterprise })">{{ a.enterprise }}</a>
              · {{ a.dimension_label }} · {{ fmtTime(a.created_at) }}
            </div>
          </div>
          <span class="ai-status" :class="`st-${a.status}`">{{ a.status_label }}</span>
        </div>
      </div>

      <!-- 详情 -->
      <div class="card detail-card">
        <div v-if="!active" class="empty">选择左侧预警查看详情与处置</div>
        <template v-else>
          <div class="detail-head">
            <span class="chip" :style="{ background: levelOf(active.level).color }">{{ levelOf(active.level).label }}</span>
            <span class="ai-status" :class="`st-${active.status}`">{{ active.status_label }}</span>
          </div>
          <h3 class="detail-title">{{ active.title }}</h3>
          <div class="detail-meta">
            {{ active.enterprise }} · {{ active.dimension_label }} ·
            评分 {{ active.score ?? '—' }} · 生成 {{ fmtTime(active.created_at) }}
            <template v-if="active.handler"> · 处理人 {{ active.handler }}</template>
          </div>
          <p class="detail-summary">{{ active.summary }}</p>

          <h4 class="sec">证据链（{{ active.evidence.length }}）</h4>
          <ul class="evidence">
            <li v-for="(ev, i) in active.evidence" :key="i">
              <span class="ev-text">{{ ev.text ?? ev.note ?? JSON.stringify(ev) }}</span>
              <span v-if="ev.source" class="ev-src">{{ ev.source }}</span>
            </li>
          </ul>

          <h4 class="sec">处置流水（{{ active.notes.length }}）</h4>
          <ul class="notes">
            <li v-for="(n, i) in active.notes" :key="i">
              <b>{{ n.status_label }}</b> · {{ n.handler || '—' }} · {{ fmtTime(n.ts) }}
              <div v-if="n.note" class="note-text">{{ n.note }}</div>
            </li>
            <li v-if="!active.notes.length" class="empty">尚未处置</li>
          </ul>

          <div class="handle-box">
            <input v-model="handlerName" class="toolbar-input" placeholder="处理人姓名" />
            <input v-model="noteText" class="toolbar-input note-input" placeholder="处置说明（可选）" />
            <div class="handle-actions">
              <button class="btn primary small" :disabled="acting" @click="act('start')">开始处理</button>
              <button class="btn small" :disabled="acting" @click="act('resolve')">标记已处置</button>
              <button class="btn ghost small" :disabled="acting" @click="act('ignore')">忽略</button>
              <button class="btn ghost small" :disabled="acting" @click="act('reopen')">重新打开</button>
              <button class="btn ghost small" @click="downloadReport(active)">📄 导出报告</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}

.alert-layout {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
  gap: 12px;
  align-items: start;
}

.list-card {
  padding: 8px;
  max-height: 620px;
  overflow-y: auto;
}

.alert-item {
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding: 10px;
  border-radius: 10px;
  cursor: pointer;
  border: 1px solid transparent;
}

.alert-item:hover {
  background: var(--hover);
}

.alert-item.active {
  background: rgba(37, 99, 235, 0.07);
  border-color: rgba(37, 99, 235, 0.35);
}

.lv-bar {
  width: 4px;
  border-radius: 3px;
  flex: none;
}

.ai-main {
  flex: 1;
  min-width: 0;
}

.ai-title {
  font-size: 13px;
  font-weight: 600;
}

.ai-meta {
  font-size: 11.5px;
  color: var(--text-sub);
  margin-top: 3px;
}

.ai-status {
  flex: none;
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 9px;
  height: fit-content;
  border: 1px solid var(--border);
  color: var(--text-sub);
}

.st-pending {
  color: var(--danger);
  border-color: rgba(220, 38, 38, 0.35);
  background: rgba(220, 38, 38, 0.06);
}

.st-handling {
  color: var(--warn);
  border-color: rgba(217, 119, 6, 0.35);
  background: rgba(217, 119, 6, 0.06);
}

.st-resolved {
  color: var(--ok);
  border-color: rgba(22, 163, 74, 0.35);
  background: rgba(22, 163, 74, 0.06);
}

.detail-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-head {
  display: flex;
  gap: 8px;
  align-items: center;
}

.detail-title {
  margin: 4px 0 2px;
  font-size: 15px;
}

.detail-meta {
  font-size: 11.5px;
  color: var(--text-sub);
}

.detail-summary {
  margin: 6px 0 4px;
  font-size: 13px;
  background: var(--hover);
  border-left: 3px solid var(--primary);
  padding: 8px 12px;
  border-radius: 6px;
}

.sec {
  margin: 12px 0 6px;
  font-size: 13px;
}

.evidence,
.notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.evidence li {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  border-bottom: 1px dashed var(--border);
  padding-bottom: 6px;
}

.ev-text {
  flex: 1;
}

.ev-src {
  font-size: 11px;
  color: var(--text-sub);
  flex: none;
}

.notes li {
  font-size: 12px;
  color: var(--text-sub);
}

.note-text {
  color: var(--text);
  margin-top: 2px;
}

.handle-box {
  margin-top: 14px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.note-input {
  width: 100%;
}

.handle-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 1000px) {
  .alert-layout {
    grid-template-columns: 1fr;
  }
}
</style>

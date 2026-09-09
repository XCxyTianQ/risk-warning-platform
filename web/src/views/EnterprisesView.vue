<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { api, levelOf, type DashboardSummary } from '../api'
import { openPanel } from '../workspace/store'

const data = ref<DashboardSummary | null>(null)
const keyword = ref('')
const levelFilter = ref('all')
const sortKey = ref<'level' | 'name'>('level')
const loading = ref(true)
const error = ref('')
const toast = ref('')

// 添加企业
const addOpen = ref(false)
const addName = ref('')
const addCode = ref('')
const addAutoFetch = ref(true)
const candidates = ref<{ code: string; name: string }[]>([])
const resolving = ref(false)
const creating = ref(false)
const addError = ref('')

const LEVEL_ORDER: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3, gray: 4 }

const rows = computed(() => {
  let list = data.value?.enterprises ?? []
  if (levelFilter.value !== 'all') list = list.filter((e) => e.level === levelFilter.value)
  const kw = keyword.value.trim()
  if (kw) {
    const k = kw.toLowerCase()
    list = list.filter(
      (e) =>
        e.name.includes(kw) ||
        (e.industry ?? '').includes(kw) ||
        (e.stock_code ?? '').toLowerCase().includes(k),
    )
  }
  return [...list].sort((a, b) =>
    sortKey.value === 'name'
      ? a.name.localeCompare(b.name, 'zh-CN')
      : (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9),
  )
})

const counts = computed(() => data.value?.level_counts ?? {})

async function load() {
  loading.value = true
  try {
    data.value = await api.summary()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// ---------- 添加企业 ----------
function openAdd() {
  addOpen.value = true
  addName.value = ''
  addCode.value = ''
  candidates.value = []
  addError.value = ''
  addAutoFetch.value = true
}

async function resolve() {
  const name = addName.value.trim()
  if (!name) return
  resolving.value = true
  addError.value = ''
  try {
    const r = await api.resolveStock(name)
    candidates.value = r.candidates
    if (!r.candidates.length) addError.value = '未匹配到 A 股代码（非上市企业可留空，仅建档）'
  } catch (e) {
    addError.value = (e as Error).message
  } finally {
    resolving.value = false
  }
}

async function create() {
  const name = addName.value.trim()
  if (!name) return
  creating.value = true
  addError.value = ''
  try {
    const r = await api.createEnterprise({ name, stock_code: addCode.value || undefined, auto_fetch: addAutoFetch.value })
    addOpen.value = false
    await load()
    const dims = r.refresh?.dimensions ?? {}
    const parts = Object.entries(dims).map(([k, v]: any) =>
      v.ok ? `${k} +${v.inserted ?? 0}` : `${k} ${v.gap || v.error || '无'}`,
    )
    toast.value = `已添加「${r.name}」${r.stock_code ? `（${r.stock_code}）` : ''}${parts.length ? ' · ' + parts.join('；') : ''}`
    setTimeout(() => (toast.value = ''), 6000)
    if (r.enterprise_id) openPanel('profile', { props: { enterpriseId: r.enterprise_id }, title: r.name })
  } catch (e) {
    addError.value = (e as Error).message
  } finally {
    creating.value = false
  }
}

async function remove(id: number, name: string) {
  if (!confirm(`确定删除「${name}」及其全部数据？`)) return
  try {
    await api.deleteEnterprise(id)
    toast.value = `已删除「${name}」`
    setTimeout(() => (toast.value = ''), 4000)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>企业档案</h2>
        <p class="page-sub">共 {{ data?.enterprise_total ?? 0 }} 家企业 · 点击行进入详情</p>
      </div>
      <button class="btn primary small" @click="openAdd">＋ 添加企业</button>
    </div>

    <p v-if="toast" class="toast">{{ toast }}</p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="toolbar">
      <input v-model="keyword" class="toolbar-input" placeholder="搜索企业名称 / 股票代码 / 行业" />
      <div class="chips">
        <button class="chip-btn" :class="{ active: levelFilter === 'all' }" @click="levelFilter = 'all'">
          全部 {{ data?.enterprise_total ?? 0 }}
        </button>
        <button
          v-for="lv in ['red', 'orange', 'yellow', 'green']"
          :key="lv"
          class="chip-btn"
          :class="{ active: levelFilter === lv }"
          @click="levelFilter = lv"
        >
          <i class="dot" :style="{ background: levelOf(lv).color }"></i>{{ levelOf(lv).label }} {{ counts[lv] ?? 0 }}
        </button>
      </div>
      <select v-model="sortKey" class="toolbar-select">
        <option value="level">按风险等级排序</option>
        <option value="name">按名称排序</option>
      </select>
    </div>

    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th>企业名称</th>
            <th>行业</th>
            <th>综合评分</th>
            <th>等级</th>
            <th>财务健康</th>
            <th>法律合规</th>
            <th>舆情声誉</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in rows" :key="e.id" class="clickable" @click="openPanel('profile', { props: { enterpriseId: e.id }, title: e.name })">
            <td class="name">{{ e.name }}</td>
            <td>{{ e.industry }}</td>
            <td>
              <span class="score-cell" :style="{ color: levelOf(e.level).color }">{{ e.score ?? '—' }}</span>
              <span class="grade-cell" :style="{ background: levelOf(e.level).color }">{{ e.grade }}</span>
            </td>
            <td><span class="chip" :style="{ background: levelOf(e.level).color }">{{ levelOf(e.level).label }}</span></td>
            <td><span class="level-text" :style="{ color: levelOf(e.dimensions.finance).color }">{{ e.dimension_scores?.finance ?? '—' }}</span></td>
            <td><span class="level-text" :style="{ color: levelOf(e.dimensions.legal).color }">{{ e.dimension_scores?.legal ?? '—' }}</span></td>
            <td><span class="level-text" :style="{ color: levelOf(e.dimensions.news).color }">{{ e.dimension_scores?.news ?? '—' }}</span></td>
            <td class="arrow" @click.stop>
              <button class="row-del" title="删除企业" @click="remove(e.id, e.name)">✕</button>
            </td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="8" class="empty">没有匹配的企业</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 添加企业弹窗 -->
    <div v-if="addOpen" class="mask" @click.self="addOpen = false">
      <div class="dialog">
        <h3>添加企业</h3>
        <p class="dlg-sub">输入企业名称，自动解析 A 股代码并拉取公开数据（东方财富 / 新浪 / 巨潮）</p>

        <label class="field">
          <span>企业名称 *</span>
          <input v-model="addName" placeholder="例如：比亚迪 / 三一重工 / 某科技有限公司" @keyup.enter="resolve" />
        </label>

        <div class="dlg-row">
          <button class="btn ghost small" :disabled="resolving || !addName.trim()" @click="resolve">
            {{ resolving ? '解析中…' : '🔍 解析股票代码' }}
          </button>
          <span class="dlg-hint">非上市企业可跳过解析，仅建档</span>
        </div>

        <div v-if="candidates.length" class="cands">
          <button
            v-for="c in candidates"
            :key="c.code"
            class="cand"
            :class="{ active: addCode === c.code }"
            @click="addCode = c.code"
          >
            <b>{{ c.name }}</b>
            <span>{{ c.code }}</span>
          </button>
        </div>

        <label class="field checkbox">
          <input v-model="addAutoFetch" type="checkbox" />
          <span>添加后自动拉取公开数据（财报 / 新闻 / 诉讼）</span>
        </label>

        <p v-if="addError" class="error-box">{{ addError }}</p>

        <div class="dlg-actions">
          <button class="btn ghost" @click="addOpen = false">取消</button>
          <button class="btn primary" :disabled="creating || !addName.trim()" @click="create">
            {{ creating ? '创建并拉取中…' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-del {
  border: none;
  background: transparent;
  color: var(--text-sub);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.row-del:hover {
  color: var(--danger);
  background: rgba(220, 38, 38, 0.08);
}

/* 弹窗 */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 60;
  display: flex;
  justify-content: center;
  padding-top: 10vh;
}

.dialog {
  width: min(520px, 92vw);
  height: fit-content;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  padding: 18px 20px;
}

.dialog h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.dlg-sub {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-sub);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  margin-bottom: 12px;
}

.field input[type='text'],
.field input:not([type]) {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
}

.field input:focus {
  border-color: var(--primary);
}

.field.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.dlg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.dlg-hint {
  font-size: 11.5px;
  color: var(--text-sub);
}

.cands {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.cand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;
  font-family: inherit;
  color: var(--text);
  font-size: 12.5px;
}

.cand span {
  font-size: 11px;
  color: var(--text-sub);
  font-family: Consolas, monospace;
}

.cand.active {
  border-color: var(--primary);
  background: rgba(37, 99, 235, 0.08);
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>

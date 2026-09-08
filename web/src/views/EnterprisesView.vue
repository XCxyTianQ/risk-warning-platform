<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api, levelOf, type DashboardSummary } from '../api'

const router = useRouter()
const data = ref<DashboardSummary | null>(null)
const keyword = ref('')
const levelFilter = ref('all')
const sortKey = ref<'level' | 'name'>('level')
const loading = ref(true)
const error = ref('')

const LEVEL_ORDER: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3, gray: 4 }

const rows = computed(() => {
  let list = data.value?.enterprises ?? []
  if (levelFilter.value !== 'all') list = list.filter((e) => e.level === levelFilter.value)
  const kw = keyword.value.trim()
  if (kw) list = list.filter((e) => e.name.includes(kw) || (e.industry ?? '').includes(kw))
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

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>企业档案</h2>
        <p class="page-sub">共 {{ data?.enterprise_total ?? 0 }} 家企业 · 点击行进入详情</p>
      </div>
    </div>

    <div class="toolbar">
      <input v-model="keyword" class="toolbar-input" placeholder="搜索企业名称 / 行业" />
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

    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th>企业名称</th>
            <th>行业</th>
            <th>综合等级</th>
            <th>财务</th>
            <th>法律</th>
            <th>舆情</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in rows" :key="e.id" class="clickable" @click="router.push(`/enterprises/${e.id}`)">
            <td class="name">{{ e.name }}</td>
            <td>{{ e.industry }}</td>
            <td><span class="chip" :style="{ background: levelOf(e.level).color }">{{ levelOf(e.level).label }}</span></td>
            <td><span class="level-text" :style="{ color: levelOf(e.dimensions.finance).color }">{{ levelOf(e.dimensions.finance).label }}</span></td>
            <td><span class="level-text" :style="{ color: levelOf(e.dimensions.legal).color }">{{ levelOf(e.dimensions.legal).label }}</span></td>
            <td><span class="level-text" :style="{ color: levelOf(e.dimensions.news).color }">{{ levelOf(e.dimensions.news).label }}</span></td>
            <td class="arrow">→</td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="7" class="empty">没有匹配的企业</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

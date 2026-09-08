<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api, DIM_LABEL, fmtTime, type RiskFact } from '../api'

const router = useRouter()
const items = ref<RiskFact[]>([])
const dim = ref('all')
const loading = ref(true)
const error = ref('')

const filtered = computed(() =>
  dim.value === 'all' ? items.value : items.value.filter((f) => f.dimension === dim.value),
)

const dimCounts = computed(() => {
  const c: Record<string, number> = {}
  items.value.forEach((f) => (c[f.dimension] = (c[f.dimension] ?? 0) + 1))
  return c
})

async function load() {
  loading.value = true
  try {
    const r = await api.facts()
    items.value = r.items
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
        <h2>风险线索</h2>
        <p class="page-sub">大模型研判产出的风险事实（带证据来源，可追溯）</p>
      </div>
      <button class="btn ghost" :disabled="loading" @click="load">刷新</button>
    </div>

    <div class="toolbar">
      <div class="chips">
        <button class="chip-btn" :class="{ active: dim === 'all' }" @click="dim = 'all'">
          全部 {{ items.length }}
        </button>
        <button
          v-for="(label, key) in DIM_LABEL"
          :key="key"
          class="chip-btn"
          :class="{ active: dim === key }"
          @click="dim = key"
        >
          {{ label }} {{ dimCounts[key] ?? 0 }}
        </button>
      </div>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="card">
      <ul v-if="filtered.length" class="fact-list">
        <li v-for="f in filtered" :key="f.id">
          <span class="ev-dim">{{ f.dimension_label }}</span>
          <div class="fact-body">
            <div class="fact-text">{{ f.text }}</div>
            <div class="fact-meta">
              <a class="link" @click.prevent="router.push(`/enterprises/${f.enterprise_id}`)">{{ f.enterprise }}</a>
              · 置信度 {{ (f.confidence * 100).toFixed(0) }}% · {{ fmtTime(f.ts) }}
            </div>
          </div>
        </li>
      </ul>
      <p v-else class="empty">
        暂无线索——先在「智能研判」对企业跑一次分析（大模型会把证据写入风险事实库）
      </p>
    </div>
  </div>
</template>

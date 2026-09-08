<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'

import { api, DIM_LABEL, fmtTime, gradeColor, levelOf, scoreColor, type DashboardSummary } from '../api'
import BaseChart from '../components/BaseChart.vue'

const router = useRouter()
const data = ref<DashboardSummary | null>(null)
const loading = ref(true)
const error = ref('')

const stats = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { label: '监测企业', value: d.enterprise_total, tone: 'primary', icon: '🏢' },
    { label: '平均评分', value: d.avg_score ?? '—', tone: 'cyan', icon: '⭐' },
    { label: '高风险', value: d.level_counts.red ?? 0, tone: 'red', icon: '🚨' },
    { label: '较高风险', value: d.level_counts.orange ?? 0, tone: 'orange', icon: '⚠️' },
  ]
})

const pieOption = computed<EChartsOption>(() => {
  const c = data.value?.level_counts ?? {}
  const order = ['red', 'orange', 'yellow', 'green']
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, icon: 'circle', textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: ['46%', '70%'],
      center: ['50%', '44%'],
      itemStyle: { borderColor: 'transparent', borderWidth: 2 },
      label: { show: false },
      data: order
        .filter((k) => (c[k] ?? 0) > 0)
        .map((k) => ({ name: levelOf(k).label, value: c[k] ?? 0, itemStyle: { color: levelOf(k).color } })),
    }],
  }
})

const dimOption = computed<EChartsOption>(() => {
  const dl = data.value?.dimension_levels ?? {}
  const dims = Object.keys(DIM_LABEL).filter((d) => dl[d])
  const order = ['red', 'orange', 'yellow', 'green', 'gray']
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, icon: 'circle', textStyle: { fontSize: 11 } },
    grid: { left: 40, right: 16, top: 20, bottom: 44 },
    xAxis: { type: 'category', data: dims.map((d) => DIM_LABEL[d]), axisTick: { show: false } },
    yAxis: { type: 'value', minInterval: 1 },
    series: order.map((lv) => ({
      name: levelOf(lv).label,
      type: 'bar',
      stack: 'total',
      barWidth: 26,
      itemStyle: { color: levelOf(lv).color, borderRadius: 2 },
      data: dims.map((d) => dl[d]?.[lv] ?? 0),
    })),
  }
})

async function load() {
  loading.value = true
  error.value = ''
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
        <h2>风险总览</h2>
        <p class="page-sub">企业风险分布与最新风险线索（演示数据集 v2 · 公开信源）</p>
      </div>
      <button class="btn ghost" :disabled="loading" @click="load">刷新数据</button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="stat-grid">
      <div v-for="s in stats" :key="s.label" class="stat-card" :class="`tone-${s.tone}`">
        <div class="stat-icon">{{ s.icon }}</div>
        <div>
          <div class="stat-value">{{ loading ? '—' : s.value }}</div>
          <div class="stat-label">{{ s.label }}</div>
        </div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="card">
        <h3 class="card-title">风险等级分布</h3>
        <BaseChart v-if="data" :option="pieOption" height="240px" />
      </div>
      <div class="card">
        <h3 class="card-title">各维度等级构成</h3>
        <BaseChart v-if="data" :option="dimOption" height="240px" />
      </div>
      <div class="card">
        <h3 class="card-title">最新风险线索（共 {{ data?.fact_total ?? 0 }} 条）</h3>
        <ul v-if="data?.recent_facts.length" class="timeline">
          <li v-for="(f, i) in data.recent_facts" :key="i">
            <span class="dot" :style="{ background: levelOf('yellow').color }"></span>
            <div>
              <div class="tl-title">{{ f.text }}</div>
              <div class="tl-meta">{{ f.enterprise }} · {{ DIM_LABEL[f.dimension] ?? f.dimension }} · {{ fmtTime(f.ts) }}</div>
            </div>
          </li>
        </ul>
        <p v-else class="empty">暂无风险线索——去「智能研判」对企业跑一次分析</p>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">企业风险矩阵</h3>
      <table class="table">
        <thead>
          <tr>
            <th>企业</th>
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
          <tr v-for="e in data?.enterprises ?? []" :key="e.id" class="clickable" @click="router.push(`/enterprises/${e.id}`)">
            <td class="name">{{ e.name }}</td>
            <td>{{ e.industry }}</td>
            <td>
              <span class="score-cell" :style="{ color: scoreColor(e.score) }">{{ e.score ?? '—' }}</span>
              <span class="grade-cell" :style="{ background: gradeColor(e.grade) }">{{ e.grade }}</span>
            </td>
            <td><span class="chip" :style="{ background: levelOf(e.level).color }">{{ levelOf(e.level).label }}</span></td>
            <td><span class="level-text" :style="{ color: scoreColor(e.dimension_scores?.finance) }">{{ e.dimension_scores?.finance ?? '—' }}</span></td>
            <td><span class="level-text" :style="{ color: scoreColor(e.dimension_scores?.legal) }">{{ e.dimension_scores?.legal ?? '—' }}</span></td>
            <td><span class="level-text" :style="{ color: scoreColor(e.dimension_scores?.news) }">{{ e.dimension_scores?.news ?? '—' }}</span></td>
            <td class="arrow">→</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

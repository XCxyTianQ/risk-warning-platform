<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'

import { api, DIM_LABEL, fmtTime, levelOf, type RiskSnapshot } from '../api'
import BaseChart from '../components/BaseChart.vue'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)

const profile = ref<any>(null)
const snapshot = ref<RiskSnapshot | null>(null)
const loading = ref(true)
const analyzing = ref(false)
const error = ref('')
const toast = ref('')

const radarOption = computed<EChartsOption>(() => {
  const dims = snapshot.value?.dimensions ?? {}
  const keys = Object.keys(DIM_LABEL).filter((k) => dims[k])
  return {
    tooltip: {},
    radar: {
      indicator: keys.map((k) => ({ name: DIM_LABEL[k], max: 100 })),
      radius: '62%',
      axisName: { fontSize: 12, color: '#64748b' },
      splitArea: { areaStyle: { color: ['transparent'] } },
    },
    series: [{
      type: 'radar',
      data: [{
        value: keys.map((k) => levelOf(dims[k]?.level).radar),
        name: '风险指数',
        areaStyle: { color: 'rgba(37, 99, 235, 0.22)' },
        lineStyle: { color: '#2563eb', width: 2 },
        itemStyle: { color: '#2563eb' },
      }],
    }],
  }
})

const dimRows = computed(() =>
  Object.keys(snapshot.value?.dimensions ?? {}).map((k) => ({
    key: k,
    label: DIM_LABEL[k] ?? k,
    level: snapshot.value!.dimensions[k].level,
    indicators: snapshot.value!.dimensions[k].indicators ?? {},
  })),
)

function fmtIndicator(key: string, ind: Record<string, any>): string {
  if (key === 'finance') {
    if (!ind.available) return '无公开财报（数据不足）'
    return `资产负债率 ${ind.debt_ratio}% · 净利润 ${Number(ind.net_profit).toLocaleString()} 万（${ind.year}）`
  }
  if (key === 'legal') return `涉诉/记录 ${ind.count ?? 0} 项 · 涉案金额 ${Number(ind.amount ?? 0).toLocaleString()} 万`
  if (key === 'news') return `新闻 ${ind.total ?? 0} 条 · 负面 ${ind.negative ?? 0} 条（${Math.round((ind.negative_ratio ?? 0) * 100)}%）`
  return ''
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [p, s] = await Promise.all([api.enterprise(id), api.risk(id)])
    profile.value = p
    snapshot.value = s
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function reAnalyze() {
  if (!profile.value || analyzing.value) return
  analyzing.value = true
  toast.value = ''
  try {
    await api.analyze(profile.value.name)
    toast.value = '研判完成，已更新风险事实'
    await load()
  } catch (e) {
    toast.value = '研判失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    analyzing.value = false
    setTimeout(() => (toast.value = ''), 4000)
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <button class="btn ghost small" @click="router.back()">← 返回</button>
        <h2>{{ profile?.name ?? '企业详情' }}</h2>
        <p class="page-sub" v-if="profile">
          {{ profile.industry }} · 法定代表人 {{ profile.legal_rep }} · 注册资本 {{ profile.reg_capital_wan }} 万 ·
          成立 {{ profile.reg_date }}
        </p>
      </div>
      <button class="btn primary" :disabled="analyzing" @click="reAnalyze">
        {{ analyzing ? '研判中…' : '重新研判' }}
      </button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="toast" class="toast">{{ toast }}</p>

    <div class="detail-grid">
      <div class="card">
        <h3 class="card-title">风险画像</h3>
        <div class="level-line">
          综合等级
          <span class="chip" :style="{ background: levelOf(snapshot?.verdict_level).color }">
            {{ levelOf(snapshot?.verdict_level).label }}
          </span>
        </div>
        <BaseChart v-if="snapshot" :option="radarOption" height="250px" />
      </div>

      <div class="card">
        <h3 class="card-title">维度指标</h3>
        <div v-for="d in dimRows" :key="d.key" class="dim-row">
          <div class="dim-row-head">
            <span>{{ d.label }}</span>
            <span class="level-text" :style="{ color: levelOf(d.level).color }">{{ levelOf(d.level).label }}</span>
          </div>
          <div class="dim-bar">
            <div class="dim-fill" :style="{ width: levelOf(d.level).radar + '%', background: levelOf(d.level).color }"></div>
          </div>
          <div class="dim-note">{{ fmtIndicator(d.key, d.indicators) }}</div>
        </div>
        <p class="hint" v-if="profile?.data_note">{{ profile.data_note }}</p>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">风险事实与证据（{{ snapshot?.facts.length ?? 0 }} 条）</h3>
      <ul v-if="snapshot?.facts.length" class="evidence">
        <li v-for="(f, i) in snapshot.facts" :key="i">
          <span class="ev-dim">{{ DIM_LABEL[f.dimension] ?? f.dimension }}</span>
          <span class="ev-text">{{ f.text }}</span>
          <span class="ev-src">{{ f.evidence?.source }} · {{ f.evidence?.date || fmtTime(f.ts) }}</span>
        </li>
      </ul>
      <p v-else class="empty">暂无风险事实——点击右上角「重新研判」让大模型分析一次</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'

import { api, DIM_LABEL, fmtTime, gradeColor, levelOf, scoreColor, type RiskSnapshot } from '../api'
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

/** 企业评分画像：六维分数雷达 */
const radarOption = computed<EChartsOption>(() => {
  const dims = snapshot.value?.dimensions ?? {}
  const keys = Object.keys(DIM_LABEL).filter((k) => dims[k])
  return {
    tooltip: {},
    radar: {
      indicator: keys.map((k) => ({ name: DIM_LABEL[k], max: 100 })),
      radius: '64%',
      center: ['50%', '52%'],
      axisName: { fontSize: 11.5, color: '#64748b' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.28)' } },
      splitArea: { areaStyle: { color: ['rgba(37,99,235,0.03)', 'rgba(37,99,235,0.06)'] } },
    },
    series: [{
      type: 'radar',
      symbolSize: 5,
      data: [{
        value: keys.map((k) => dims[k]?.score ?? 0),
        name: '企业评分',
        areaStyle: { color: 'rgba(37, 99, 235, 0.22)' },
        lineStyle: { color: '#2563eb', width: 2 },
        itemStyle: { color: '#2563eb' },
      }],
    }],
  }
})

const dimRows = computed(() =>
  Object.keys(DIM_LABEL)
    .filter((k) => snapshot.value?.dimensions?.[k])
    .map((k) => ({
      key: k,
      label: DIM_LABEL[k],
      score: snapshot.value!.dimensions[k].score,
      level: snapshot.value!.dimensions[k].level,
      note: snapshot.value!.dimensions[k].note ?? '',
    })),
)

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
    toast.value = '研判完成，评分画像已更新'
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
      <!-- 企业评分画像 -->
      <div class="card">
        <h3 class="card-title">企业评分画像</h3>
        <div class="score-head">
          <div class="score-main">
            <span class="score-num" :style="{ color: scoreColor(snapshot?.score) }">
              {{ snapshot?.score ?? '—' }}
            </span>
            <span class="score-unit">分</span>
          </div>
          <div class="score-side">
            <span class="grade-badge" :style="{ background: gradeColor(snapshot?.grade) }">
              {{ snapshot?.grade ?? '—' }} · {{ snapshot?.grade_label ?? '数据不足' }}
            </span>
            <span class="score-sub">
              风险等级
              <b :style="{ color: levelOf(snapshot?.verdict_level).color }">{{ levelOf(snapshot?.verdict_level).label }}</b>
            </span>
          </div>
        </div>
        <BaseChart v-if="snapshot" :option="radarOption" height="270px" />
        <p class="hint">综合评分 = 六个可用维度平均分（越高越健康）；灰色维度表示数据不足，不参与计算。</p>
      </div>

      <!-- 六维明细 -->
      <div class="card">
        <h3 class="card-title">六维评分明细</h3>
        <div v-for="d in dimRows" :key="d.key" class="dim-row">
          <div class="dim-row-head">
            <span>{{ d.label }}</span>
            <span class="dim-score" :style="{ color: scoreColor(d.score) }">
              {{ d.score ?? '—' }}<small v-if="d.score !== null">/100</small>
            </span>
          </div>
          <div class="dim-bar">
            <div class="dim-fill" :style="{ width: (d.score ?? 0) + '%', background: scoreColor(d.score) }"></div>
          </div>
          <div class="dim-note">{{ d.note }}</div>
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

<style scoped>
.score-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 6px;
}

.score-main {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.score-num {
  font-size: 42px;
  font-weight: 700;
  line-height: 1;
}

.score-unit {
  font-size: 13px;
  color: var(--text-sub);
}

.score-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.grade-badge {
  color: #fff;
  font-size: 12.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 4px 14px;
  text-align: center;
}

.score-sub {
  font-size: 12px;
  color: var(--text-sub);
}

.dim-score {
  font-weight: 700;
  font-size: 15px;
}

.dim-score small {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-sub);
}
</style>

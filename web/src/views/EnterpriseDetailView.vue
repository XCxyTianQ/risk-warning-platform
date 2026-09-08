<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'

import { api, DIM_LABEL, fmtTime, gradeColor, levelOf, scoreColor, type RiskSnapshot } from '../api'
import BaseChart from '../components/BaseChart.vue'

const route = useRoute()
const router = useRouter()
const props = defineProps<{ enterpriseId?: number }>()
const id = computed(() => props.enterpriseId ?? Number(route.params.id))

const profile = ref<any>(null)
const snapshot = ref<RiskSnapshot | null>(null)
const avgScore = ref<number | null>(null)
const loading = ref(true)
const analyzing = ref(false)
const error = ref('')
const toast = ref('')

/** 评级解读文案 */
const GRADE_NARRATIVE: Record<string, { title: string; body: string; advice: string }> = {
  AAA: {
    title: '经营状况优秀',
    body: '各维度风险指标处于健康区间，财务结构稳健、无重大司法与信用负面记录，舆情表现良好。',
    advice: '保持常规监测，按季度复核评分变化即可。',
  },
  AA: {
    title: '经营状况良好',
    body: '整体风险可控，个别维度存在轻微压力（如舆情波动或行业景气度变化），尚未构成实质风险。',
    advice: '建议按月跟踪薄弱维度，出现连续两期下滑时启动专项核查。',
  },
  A: {
    title: '总体稳健',
    body: '经营基本面尚可，但已有维度出现波动信号，需关注其演变趋势。',
    advice: '建议纳入常规观察名单，重点跟踪扣分项对应的原始数据变化。',
  },
  BBB: {
    title: '存在关注级风险',
    body: '部分维度已出现值得关注的风险信号，若继续恶化可能影响履约与偿债能力。',
    advice: '建议纳入重点观察名单，30 天内完成一次人工复核并留存结论。',
  },
  BB: {
    title: '风险信号较明显',
    body: '多个维度同时承压，风险已具备传导可能性（如诉讼增加、负面舆情扩散、现金流趋紧）。',
    advice: '建议限期核查并制定应对预案：核实债务与诉讼进展、评估供应链替代方案。',
  },
  C: {
    title: '高风险',
    body: '核心维度严重受损，存在失信/被执行、重大诉讼、持续亏损或高负债等实质风险。',
    advice: '建议立即启动风险处置：暂停新增授信、核查资产与担保情况、评估保全与退出方案。',
  },
}

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

const scored = computed(() => dimRows.value.filter((d) => d.score !== null))
const missing = computed(() => dimRows.value.filter((d) => d.score === null))
const strengths = computed(() => [...scored.value].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 2))
const weaknesses = computed(() => [...scored.value].sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2))

const narrative = computed(() => GRADE_NARRATIVE[snapshot.value?.grade ?? ''] ?? null)

const compareText = computed(() => {
  const s = snapshot.value?.score
  if (s === null || s === undefined || avgScore.value === null) return ''
  const diff = Math.round((s - avgScore.value) * 10) / 10
  if (Math.abs(diff) < 1) return `与当前监测企业平均分（${avgScore.value}）基本持平`
  return diff > 0
    ? `高于当前监测企业平均分（${avgScore.value}）${diff} 分`
    : `低于当前监测企业平均分（${avgScore.value}）${Math.abs(diff)} 分`
})

/** 评级标尺：C <50 · BB 50-59 · BBB 60-69 · A 70-79 · AA 80-89 · AAA ≥90 */
const SCALE = [
  { grade: 'C', label: '高风险', min: 0, max: 50 },
  { grade: 'BB', label: '预警', min: 50, max: 60 },
  { grade: 'BBB', label: '关注', min: 60, max: 70 },
  { grade: 'A', label: '稳健', min: 70, max: 80 },
  { grade: 'AA', label: '良好', min: 80, max: 90 },
  { grade: 'AAA', label: '优秀', min: 90, max: 100 },
]
const markerLeft = computed(() => {
  const s = snapshot.value?.score
  if (s === null || s === undefined) return null
  return `${Math.max(1, Math.min(99, s))}%`
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [p, s, summary] = await Promise.all([api.enterprise(id.value), api.risk(id.value), api.summary()])
    profile.value = p
    snapshot.value = s
    avgScore.value = summary.avg_score
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
        <button v-if="!props.enterpriseId" class="btn ghost small" @click="router.back()">← 返回</button>
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

        <BaseChart v-if="snapshot" :option="radarOption" height="260px" />

        <!-- 评级标尺 -->
        <div class="scale-wrap">
          <div class="scale">
            <div
              v-for="s in SCALE"
              :key="s.grade"
              class="scale-seg"
              :style="{ background: gradeColor(s.grade) }"
              :title="`${s.grade} · ${s.label}（${s.min}~${s.max}分）`"
            >
              <span>{{ s.grade }}</span>
            </div>
          </div>
          <div v-if="markerLeft" class="scale-marker" :style="{ left: markerLeft }">
            <span class="marker-dot" :style="{ background: gradeColor(snapshot?.grade) }"></span>
          </div>
          <div class="scale-labels">
            <span>0</span><span>50</span><span>60</span><span>70</span><span>80</span><span>90</span><span>100</span>
          </div>
        </div>
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

    <!-- 评级解读 -->
    <div class="card narrative" :style="{ borderLeftColor: gradeColor(snapshot?.grade) }">
      <div class="narr-head">
        <span class="narr-title">
          {{ narrative?.title ?? '评级解读' }}
          <span class="narr-grade" :style="{ background: gradeColor(snapshot?.grade) }">{{ snapshot?.grade ?? '—' }}</span>
        </span>
        <span class="narr-score">
          综合评分 <b :style="{ color: scoreColor(snapshot?.score) }">{{ snapshot?.score ?? '—' }}</b>
          <template v-if="compareText"> · {{ compareText }}</template>
        </span>
      </div>
      <p class="narr-body">{{ narrative?.body }}</p>

      <div class="narr-grid">
        <div class="narr-block">
          <div class="nb-title">✅ 表现较好</div>
          <div class="nb-items">
            <span v-for="d in strengths" :key="d.key" class="nb-chip" :style="{ borderColor: scoreColor(d.score), color: scoreColor(d.score) }">
              {{ d.label }} {{ d.score }}
            </span>
            <span v-if="!strengths.length" class="nb-empty">暂无可用维度</span>
          </div>
        </div>
        <div class="narr-block">
          <div class="nb-title">⚠️ 需要关注</div>
          <div class="nb-items">
            <span v-for="d in weaknesses" :key="d.key" class="nb-chip" :style="{ borderColor: scoreColor(d.score), color: scoreColor(d.score) }">
              {{ d.label }} {{ d.score }}
            </span>
            <span v-if="!weaknesses.length" class="nb-empty">暂无可用维度</span>
          </div>
        </div>
        <div class="narr-block">
          <div class="nb-title">📊 数据完整度</div>
          <div class="nb-items">
            <span class="nb-chip neutral">{{ scored.length }}/6 维度有数据</span>
            <span v-for="d in missing" :key="d.key" class="nb-chip muted">{{ d.label }} 缺失</span>
          </div>
        </div>
      </div>

      <div class="narr-advice">
        <b>建议动作：</b>{{ narrative?.advice }}
      </div>
      <p v-if="missing.length" class="hint">
        注：{{ missing.map((m) => m.label).join('、') }}维度数据不足，未参与综合评分，评分可靠性受影响；建议补充数据源后重新研判。
      </p>
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

/* 评级标尺 */
.scale-wrap {
  position: relative;
  margin: 4px 2px 6px;
}

.scale {
  display: flex;
  gap: 3px;
  height: 22px;
}

.scale-seg {
  flex: 1;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  opacity: 0.55;
  transition: opacity 0.2s;
}

.scale-seg:hover {
  opacity: 1;
}

.scale-marker {
  position: absolute;
  top: -8px;
  transform: translateX(-50%);
}

.marker-dot {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.35);
}

.scale-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-sub);
  margin-top: 4px;
}

/* 六维明细 */
.dim-score {
  font-weight: 700;
  font-size: 15px;
}

.dim-score small {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-sub);
}

/* 评级解读 */
.narrative {
  border-left: 4px solid var(--primary);
}

.narr-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.narr-title {
  font-size: 15px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.narr-grade {
  color: #fff;
  font-size: 11.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 10px;
}

.narr-score {
  font-size: 12.5px;
  color: var(--text-sub);
}

.narr-body {
  margin: 0 0 14px;
  font-size: 13.5px;
  line-height: 1.75;
}

.narr-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}

.narr-block {
  background: var(--hover);
  border-radius: 8px;
  padding: 10px 12px;
}

.nb-title {
  font-size: 12px;
  color: var(--text-sub);
  margin-bottom: 8px;
}

.nb-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.nb-chip {
  font-size: 12px;
  font-weight: 600;
  border: 1px solid;
  border-radius: 999px;
  padding: 2px 10px;
}

.nb-chip.neutral {
  border-color: var(--border);
  color: var(--text);
}

.nb-chip.muted {
  border-color: var(--border);
  color: var(--text-sub);
  font-weight: 400;
}

.nb-empty {
  font-size: 12px;
  color: var(--text-sub);
}

.narr-advice {
  background: rgba(37, 99, 235, 0.06);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
}

@media (max-width: 900px) {
  .narr-grid {
    grid-template-columns: 1fr;
  }
}
</style>

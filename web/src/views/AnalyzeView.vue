<script setup lang="ts">
import { computed, ref } from 'vue'

import { api, DIM_LABEL, gradeColor, levelOf, scoreColor, type AnalyzeResp } from '../api'

const keyword = ref('深度求索')
const loading = ref(false)
const error = ref('')
const result = ref<AnalyzeResp | null>(null)
const steps = ref<number>(0)
const showEvidence = ref(true)

const STEP_LABELS = ['获取企业档案', '读取财务数据', '读取法律记录', '读取舆情新闻', '大模型推理研判', '规则引擎交叉校验']
let timer: number | undefined

const dims = computed(() => {
  const v = result.value?.verdict
  if (!v) return []
  return Object.keys(DIM_LABEL)
    .filter((k) => v.dimensions[k])
    .map((key) => ({
      key,
      label: DIM_LABEL[key],
      level: v.dimensions[key].level,
      score: v.dimensions[key].score,
      note: v.dimensions[key].note ?? '',
    }))
})

async function run() {
  const name = keyword.value.trim()
  if (!name || loading.value) return
  loading.value = true
  error.value = ''
  result.value = null
  steps.value = 0
  timer = window.setInterval(() => {
    steps.value = Math.min(steps.value + 1, STEP_LABELS.length - 1)
  }, 1400)
  try {
    result.value = await api.analyze(name)
    steps.value = STEP_LABELS.length
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    if (timer) window.clearInterval(timer)
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>智能研判</h2>
        <p class="page-sub">输入企业名称 → 多模态大模型调用工具取数 → 六维评分 + 规则引擎交叉校验 → 证据链</p>
      </div>
    </div>

    <div class="search-bar">
      <input
        v-model="keyword"
        placeholder="输入企业名称或股票代码，例如：康美药业 / 600518 / 贵州茅台"
        @keyup.enter="run"
      />
      <button class="btn primary" :disabled="loading" @click="run">
        {{ loading ? '研判中…' : '开始研判' }}
      </button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <!-- 研判过程 -->
    <div v-if="loading" class="card">
      <h3 class="card-title">研判过程</h3>
      <ul class="steps">
        <li v-for="(s, i) in STEP_LABELS" :key="s" :class="{ done: i < steps, active: i === steps }">
          <span class="step-dot">{{ i < steps ? '✓' : i === steps ? '●' : '' }}</span>
          {{ s }}
        </li>
      </ul>
      <p class="hint">大模型推理通常需要 10~40 秒（DeepSeek v4 推理型模型）</p>
    </div>

    <!-- 结果 -->
    <template v-if="result">
      <div class="card result-head">
        <div>
          <div class="result-name">{{ result.enterprise.name }}</div>
          <div class="result-meta">
            法定代表人 {{ result.enterprise.legal_rep }} · {{ result.enterprise.industry }} ·
            {{ result.enterprise.data_note }}
          </div>
        </div>
        <div class="result-score">
          <div class="rs-num" :style="{ color: scoreColor(result.verdict.score) }">
            {{ result.verdict.score ?? '—' }}<small>分</small>
          </div>
          <div class="rs-badges">
            <span class="grade-badge" :style="{ background: gradeColor(result.verdict.grade) }">
              {{ result.verdict.grade }} · {{ result.verdict.grade_label }}
            </span>
            <span class="level-badge" :style="{ background: levelOf(result.verdict.level).color }">
              {{ levelOf(result.verdict.level).label }}
            </span>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">研判结论</h3>
        <p class="summary">{{ result.verdict.summary }}</p>
        <div class="cross-check">
          交叉校验：大模型 <b>{{ levelOf(result.verdict.llm_level).label }}</b> ·
          规则引擎 <b>{{ levelOf(result.verdict.rules_level).label }}</b> ·
          <span :class="result.verdict.cross_check_ok ? 'ok-text' : 'warn-text'">
            {{ result.verdict.cross_check_ok ? '一致 ✓' : '不一致，以规则为准' }}
          </span>
          （最终等级来源：{{ result.verdict.level_by === 'llm' ? '大模型' : '规则引擎' }}）
        </div>
      </div>

      <div class="dim-grid">
        <div v-for="d in dims" :key="d.key" class="card dim-card">
          <div class="dim-head">
            <span class="dim-name">{{ d.label }}</span>
            <span class="dim-score" :style="{ color: scoreColor(d.score) }">
              {{ d.score ?? '—' }}<small v-if="d.score !== null">/100</small>
            </span>
          </div>
          <div class="dim-bar">
            <div class="dim-fill" :style="{ width: (d.score ?? 0) + '%', background: scoreColor(d.score) }"></div>
          </div>
          <div class="dim-note">{{ d.note }}</div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title clickable" @click="showEvidence = !showEvidence">
          证据链（{{ result.verdict.evidence.length }} 条）{{ showEvidence ? ' ▾' : ' ▸' }}
        </h3>
        <ul v-if="showEvidence" class="evidence">
          <li v-for="(ev, i) in result.verdict.evidence" :key="i">
            <span class="ev-dim">{{ DIM_LABEL[ev.dimension] ?? ev.dimension }}</span>
            <span class="ev-text">{{ ev.text }}</span>
            <span class="ev-src">{{ ev.source }} · {{ ev.date }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.result-score {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.rs-num {
  font-size: 34px;
  font-weight: 700;
  line-height: 1;
}

.rs-num small {
  font-size: 13px;
  color: var(--text-sub);
  margin-left: 2px;
}

.rs-badges {
  display: flex;
  gap: 8px;
}

.grade-badge {
  color: #fff;
  font-size: 12.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 4px 14px;
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

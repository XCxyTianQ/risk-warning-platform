<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Health {
  status: string
  service: string
  version: string
}

interface Evidence {
  dimension: string
  text: string
  source?: string
  date?: string
}

interface DimensionView {
  level: string
  indicators?: {
    count?: number
    total?: number
    negative?: number
    negative_ratio?: number
    available?: boolean
    note?: string
  }
  reason?: string
}

interface Verdict {
  level: string
  level_by: string
  cross_check_ok: boolean
  llm_level: string
  rules_level: string
  dimensions: Record<string, DimensionView>
  summary: string
  evidence: Evidence[]
}

interface AnalyzeResp {
  enterprise: { id: number; name: string; legal_rep: string; industry: string; data_note?: string }
  verdict: Verdict
}

const health = ref<Health | null>(null)
const apiError = ref('')
const keyword = ref('深度求索')
const loading = ref(false)
const result = ref<AnalyzeResp | null>(null)
const error = ref('')

const LEVEL_META: Record<string, { label: string; color: string }> = {
  red: { label: '高风险', color: 'var(--danger)' },
  orange: { label: '较高风险', color: 'var(--warn)' },
  yellow: { label: '关注', color: '#ca8a04' },
  green: { label: '正常', color: 'var(--ok)' },
  gray: { label: '数据不足', color: '#9ca3af' },
}

const DIMMETA: Record<string, string> = {
  finance: '财务',
  legal: '法律',
  news: '舆情',
}

function levelOf(level: string) {
  return LEVEL_META[level] ?? LEVEL_META.gray
}

onMounted(async () => {
  try {
    const resp = await fetch('/api/health')
    health.value = await resp.json()
  } catch (e) {
    apiError.value = e instanceof Error ? e.message : String(e)
  }
})

async function onSearch() {
  const name = keyword.value.trim()
  if (!name) return
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const resp = await fetch('/api/enterprises/analyze_by_name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`)
    result.value = data
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <!-- 顶部导航 -->
  <header class="topbar">
    <div class="container topbar-inner">
      <div class="brand">
        <div class="brand-mark">险</div>
        <div>
          <div class="brand-name">企业经营风险预警平台</div>
          <div class="brand-sub">Multimodal LLM · Risk Early-Warning Platform</div>
        </div>
      </div>
      <div class="topbar-right">
        <span class="pill" :class="{ ok: health && !apiError, fail: !!apiError }">
          <i class="dot"></i>
          后端 API {{ health && !apiError ? '运行中' : apiError ? '未连接' : '检测中' }}
        </span>
        <span class="pill ok"><i class="dot"></i>大模型 · DeepSeek</span>
        <span class="ver">v0.2</span>
      </div>
    </div>
  </header>

  <!-- Hero -->
  <section class="hero">
    <div class="container">
      <h1 class="hero-title">让经营风险，<span class="grad">先人一步</span></h1>
      <p class="hero-sub">
        基于多模态大模型，融合财务、法律、舆情多源数据，为企业风险研判提供
        <b>分级预警 · 证据追溯 · 根因分析</b>
      </p>

      <div class="search-card">
        <input
          v-model="keyword"
          class="search-input"
          placeholder="输入企业名称，进行风险研判（如：深度求索）"
          @keyup.enter="onSearch"
        />
        <button class="search-btn" :disabled="loading" @click="onSearch">
          {{ loading ? '研判中…' : '智能研判' }}
        </button>
      </div>
      <p v-if="error" class="search-error">{{ error }}</p>
      <p v-else-if="loading" class="search-loading">大模型正在获取数据并推理（约 10~40 秒）…</p>
    </div>
  </section>

  <!-- 研判结果 -->
  <main v-if="result" class="container">
    <div class="result-card">
      <div class="result-head">
        <div>
          <div class="result-name">{{ result.enterprise.name }}</div>
          <div class="result-meta">
            法定代表人 {{ result.enterprise.legal_rep }} · {{ result.enterprise.industry }} ·
            数据：演示数据集 v1（信源：公开报道）
          </div>
        </div>
        <div class="level-badge" :style="{ background: levelOf(result.verdict.level).color }">
          {{ levelOf(result.verdict.level).label }}
        </div>
      </div>

      <div class="result-summary">{{ result.verdict.summary }}</div>

      <div class="dims">
        <div v-for="(dim, key) in result.verdict.dimensions" :key="key" class="dim">
          <div class="dim-name">{{ DIMMETA[key] ?? key }}</div>
          <div class="dim-level" :style="{ color: levelOf(dim.level).color }">
            {{ levelOf(dim.level).label }}
          </div>
          <div class="dim-note">
            <template v-if="key === 'finance'">{{ dim.indicators?.note ?? '暂无公开财报' }}</template>
            <template v-else>
              涉诉/记录 {{ dim.indicators?.count ?? 0 }} 项
              <template v-if="key === 'news'">
                · 负面舆情 {{ dim.indicators?.negative ?? 0 }}/{{ dim.indicators?.total ?? 0 }}
                条（占比 {{ Math.round((dim.indicators?.negative_ratio ?? 0) * 100) }}%）
              </template>
            </template>
          </div>
        </div>
      </div>

      <div class="cross-check">
        交叉校验：LLM 结论 {{ levelOf(result.verdict.llm_level).label }}（基于大模型推理）·
        规则引擎 {{ levelOf(result.verdict.rules_level).label }}（基于指标阈值）·
        {{ result.verdict.cross_check_ok ? '一致 ✓' : '不一致，以规则为准' }}
      </div>

      <section class="evidence">
        <h3>证据链（{{ result.verdict.evidence.length }} 条）</h3>
        <ul>
          <li v-for="(ev, i) in result.verdict.evidence" :key="i">
            <span class="ev-dim" :style="{ color: levelOf(`yellow`).color }">{{ DIMMETA[ev.dimension] ?? ev.dimension }}</span>
            <span class="ev-text">{{ ev.text }}</span>
            <span class="ev-src">{{ ev.source }} · {{ ev.date }}</span>
          </li>
        </ul>
      </section>
    </div>
  </main>

  <!-- 核心能力 -->
  <main class="container">
    <h2 class="section-title">核心能力</h2>
    <div class="cap-grid">
      <div class="cap">
        <div class="cap-icon">🛰️</div>
        <h3>多源数据接入</h3>
        <p>工商、司法、税务、舆情、财务多源数据融合治理，构建企业全景画像</p>
        <span class="tag plan">数据层 · 阶段3</span>
      </div>
      <div class="cap">
        <div class="cap-icon">🧠</div>
        <h3>多模态大模型理解</h3>
        <p>财报、合同、裁判文书、票据图像统一语义理解，提取风险信号</p>
        <span class="tag doing">研判已跑通</span>
      </div>
      <div class="cap">
        <div class="cap-icon">⚖️</div>
        <h3>风险研判引擎</h3>
        <p>指标规则 + 证据链 + 大模型推理三位一体，输出可解释风险结论</p>
        <span class="tag doing">规则交叉校验</span>
      </div>
      <div class="cap">
        <div class="cap-icon">🚨</div>
        <h3>分级预警中心</h3>
        <p>红/橙/黄三级预警，去重抑制与处置闭环，消息实时推送</p>
        <span class="tag plan">预警层 · 阶段4</span>
      </div>
      <div class="cap">
        <div class="cap-icon">📄</div>
        <h3>证据链报告</h3>
        <p>预警自动生成报告，逐条引用证据来源，支持人工复核</p>
        <span class="tag plan">报告层 · 阶段5</span>
      </div>
      <div class="cap">
        <div class="cap-icon">🔌</div>
        <h3>开放 API 服务</h3>
        <p>面向金融机构与企业提供风险评分、预警推送、尽调报告接口</p>
        <span class="tag plan">服务层 · 阶段5</span>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="container footer-inner">
      <span>中国国际大学生创新创业大赛项目</span>
      <span>阶段2 · 最小纵向切片（企业研判 demo）· DeepSeek API 在线</span>
    </div>
  </footer>
</template>

<style scoped>
/* ---------- 顶部导航 ---------- */
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand-mark {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow);
}
.brand-name {
  font-size: 16px;
  font-weight: 700;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-sub);
  letter-spacing: 0.4px;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-sub);
  background: #f1f4f9;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
}
.pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
}
.pill.ok .dot {
  background: var(--ok);
}
.pill.fail .dot {
  background: var(--danger);
}
.ver {
  font-size: 12px;
  color: var(--text-sub);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  background: #fff;
}

/* ---------- Hero ---------- */
.hero {
  background:
    radial-gradient(1100px 400px at 20% -10%, rgba(37, 99, 235, 0.35), transparent 60%),
    radial-gradient(900px 380px at 90% 0%, rgba(6, 182, 212, 0.28), transparent 55%),
    linear-gradient(180deg, #0b1224 0%, #0f1b3d 60%, #10224b 100%);
  color: #fff;
  padding: 48px 0 44px;
  position: relative;
  overflow: hidden;
}
.hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
  background-size: 44px 44px;
  pointer-events: none;
}
.hero .container {
  position: relative;
  z-index: 1;
}
.hero-title {
  font-size: 34px;
  margin: 0 0 10px;
  letter-spacing: 1px;
}
.grad {
  background: linear-gradient(90deg, #60a5fa, #22d3ee);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero-sub {
  color: rgba(255, 255, 255, 0.75);
  margin: 0 0 22px;
  font-size: 14px;
}
.hero-sub b {
  color: #7dd3fc;
  font-weight: 600;
}

.search-card {
  display: flex;
  gap: 8px;
  background: #fff;
  border-radius: 12px;
  padding: 8px;
  max-width: 620px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
}
.search-input {
  flex: 1;
  border: none;
  outline: none;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text);
  background: transparent;
}
.search-btn {
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--primary), var(--primary-deep));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  padding: 0 22px;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.search-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.search-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(37, 99, 235, 0.4);
}
.search-error {
  color: #fca5a5;
  font-size: 12px;
  margin: 10px 0 0;
}
.search-loading {
  color: #fcd34d;
  font-size: 12px;
  margin: 10px 0 0;
}

/* ---------- 结果卡 ---------- */
.result-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 22px 24px;
  margin-top: 24px;
}
.result-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.result-name {
  font-size: 18px;
  font-weight: 700;
}
.result-meta {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 4px;
}
.level-badge {
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  border-radius: 999px;
  padding: 8px 22px;
  white-space: nowrap;
}
.result-summary {
  margin-top: 14px;
  background: #f8fafc;
  border-left: 3px solid var(--primary);
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13.5px;
}

.dims {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 16px;
}
.dim {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: #fbfcfe;
}
.dim-name {
  font-size: 12px;
  color: var(--text-sub);
}
.dim-level {
  font-size: 17px;
  font-weight: 700;
  margin-top: 2px;
}
.dim-note {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 6px;
}

.cross-check {
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-sub);
  background: #f1f5f9;
  padding: 8px 12px;
  border-radius: 8px;
}

.evidence {
  margin-top: 18px;
}
.evidence h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.evidence ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.evidence li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  border-bottom: 1px dashed var(--border);
  padding-bottom: 8px;
}
.ev-dim {
  flex: none;
  font-size: 11px;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 6px;
}
.ev-text {
  flex: 1;
}
.ev-src {
  flex: none;
  font-size: 11px;
  color: var(--text-sub);
}

/* ---------- 主体 ---------- */
.container {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 20px;
}
main.container {
  padding-top: 12px;
}
.section-title {
  font-size: 18px;
  margin: 30px 0 14px;
  color: var(--text);
}
.cap-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.cap {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 18px 16px;
  box-shadow: var(--shadow);
  transition: transform 0.15s, box-shadow 0.15s;
}
.cap:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(16, 24, 40, 0.1);
}
.cap-icon {
  font-size: 24px;
}
.cap h3 {
  font-size: 15px;
  margin: 8px 0 6px;
}
.cap p {
  font-size: 12.5px;
  color: var(--text-sub);
  margin: 0 0 12px;
  min-height: 58px;
}
.tag {
  display: inline-block;
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 10px;
}
.tag.plan {
  color: var(--primary);
  background: rgba(37, 99, 235, 0.08);
  border: 1px solid rgba(37, 99, 235, 0.2);
}
.tag.doing {
  color: var(--ok);
  background: rgba(22, 163, 74, 0.08);
  border: 1px solid rgba(22, 163, 74, 0.2);
}

/* ---------- 页脚 ---------- */
.footer {
  margin-top: 44px;
  border-top: 1px solid var(--border);
  background: #fff;
}
.footer-inner {
  display: flex;
  justify-content: space-between;
  padding: 16px 20px;
  font-size: 12px;
  color: var(--text-sub);
}

@media (max-width: 900px) {
  .cap-grid,
  .dims {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 600px) {
  .cap-grid,
  .dims {
    grid-template-columns: 1fr;
  }
  .brand-sub,
  .topbar-right .pill {
    display: none;
  }
  .hero-title {
    font-size: 26px;
  }
}
</style>

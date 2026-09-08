<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Health {
  status: string
  service: string
  version: string
}

const health = ref<Health | null>(null)
const apiError = ref('')
const keyword = ref('')
const searchHint = ref('')

onMounted(async () => {
  try {
    const resp = await fetch('/api/health')
    health.value = await resp.json()
  } catch (e) {
    apiError.value = e instanceof Error ? e.message : String(e)
  }
})

function onSearch() {
  searchHint.value = '企业风险查询将在阶段2上线（当前为工程骨架）'
  setTimeout(() => (searchHint.value = ''), 3000)
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
        <span class="pill ok"><i class="dot"></i>模型服务 · mock</span>
        <span class="ver">v0.1</span>
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
          placeholder="输入企业名称，进行风险查询（如：样例企业）"
          @keyup.enter="onSearch"
        />
        <button class="search-btn" @click="onSearch">智能研判</button>
      </div>
      <p v-if="searchHint" class="search-hint">{{ searchHint }}</p>

      <div class="stats">
        <div class="stat">
          <div class="stat-num">100<span>+</span></div>
          <div class="stat-label">监测企业</div>
          <div class="stat-tag">演示数据</div>
        </div>
        <div class="stat">
          <div class="stat-num warn">12</div>
          <div class="stat-label">今日预警</div>
          <div class="stat-tag">演示数据</div>
        </div>
        <div class="stat">
          <div class="stat-num danger">3</div>
          <div class="stat-label">高危企业</div>
          <div class="stat-tag">演示数据</div>
        </div>
        <div class="stat">
          <div class="stat-num">6</div>
          <div class="stat-label">风险维度</div>
          <div class="stat-tag">MVP 先做 3 维</div>
        </div>
      </div>
    </div>
  </section>

  <!-- 核心能力 -->
  <main class="container">
    <h2 class="section-title">核心能力</h2>
    <div class="cap-grid">
      <div class="cap">
        <div class="cap-icon">🛰️</div>
        <h3>多源数据接入</h3>
        <p>工商、司法、税务、舆情、财务多源数据融合治理，构建企业全景画像</p>
        <span class="tag plan">数据层 · 阶段2</span>
      </div>
      <div class="cap">
        <div class="cap-icon">🧠</div>
        <h3>多模态大模型理解</h3>
        <p>财报、合同、裁判文书、票据图像统一语义理解，提取风险信号</p>
        <span class="tag plan">模型层 · 阶段2</span>
      </div>
      <div class="cap">
        <div class="cap-icon">⚖️</div>
        <h3>风险研判引擎</h3>
        <p>指标规则 + 证据链 + 大模型推理三位一体，输出可解释风险结论</p>
        <span class="tag plan">研判层 · 阶段4</span>
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

    <!-- 服务状态 -->
    <h2 class="section-title">系统状态</h2>
    <div class="status-card">
      <div class="status-row">
        <div>
          <div class="status-name">后端服务 API</div>
          <div class="status-desc">
            GET /api/health · FastAPI · 端口 8001
          </div>
        </div>
        <div class="status-value">
          <template v-if="health && !apiError">
            <span class="ok-text">✓ 正常</span>
            <small>{{ health.service }} v{{ health.version }}</small>
          </template>
          <template v-else-if="apiError">
            <span class="fail-text">✗ 未连接</span>
            <small>{{ apiError }}</small>
          </template>
          <template v-else>
            <span class="wait-text">… 检测中</span>
          </template>
        </div>
      </div>
      <div class="status-row">
        <div>
          <div class="status-name">大模型服务（mock）</div>
          <div class="status-desc">OpenAI 兼容模拟器 · localhost:9000 · 离线可用</div>
        </div>
        <div class="status-value">
          <span class="ok-text">✓ 已就绪</span>
          <small>开发期 0 成本，可切换 DeepSeek</small>
        </div>
      </div>
      <div class="status-row">
        <div>
          <div class="status-name">前端构建</div>
          <div class="status-desc">Vue 3 + TypeScript + Vite · 端口 5173</div>
        </div>
        <div class="status-value">
          <span class="ok-text">✓ 编译通过</span>
          <small>vite dev / build</small>
        </div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="container footer-inner">
      <span>中国国际大学生创新创业大赛项目</span>
      <span>阶段1 · 工程骨架 v0.1 · 前后端已连通 = 验收通过</span>
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
  padding: 56px 0 48px;
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
  font-size: 38px;
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
  margin: 0 0 26px;
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
  max-width: 560px;
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
.search-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(37, 99, 235, 0.4);
}
.search-hint {
  color: #fcd34d;
  font-size: 12px;
  margin: 10px 0 0;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-top: 28px;
  max-width: 800px;
}
.stat {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  padding: 14px 16px;
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  color: #93c5fd;
}
.stat-num.warn {
  color: #fbbf24;
}
.stat-num.danger {
  color: #f87171;
}
.stat-num span {
  font-size: 15px;
  color: rgba(255, 255, 255, 0.6);
}
.stat-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  margin-top: 2px;
}
.stat-tag {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.45);
  margin-top: 4px;
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

/* ---------- 状态卡 ---------- */
.status-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.status-row:last-child {
  border-bottom: none;
}
.status-name {
  font-weight: 600;
  font-size: 14px;
}
.status-desc {
  font-size: 12px;
  color: var(--text-sub);
  font-family: Consolas, monospace;
}
.status-value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 13px;
}
.status-value small {
  color: var(--text-sub);
  font-size: 11px;
}
.ok-text {
  color: var(--ok);
  font-weight: 600;
}
.fail-text {
  color: var(--danger);
  font-weight: 600;
}
.wait-text {
  color: var(--warn);
  font-weight: 600;
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
  .cap-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 600px) {
  .cap-grid {
    grid-template-columns: 1fr;
  }
  .brand-sub,
  .topbar-right .pill {
    display: none;
  }
  .hero-title {
    font-size: 28px;
  }
}
</style>

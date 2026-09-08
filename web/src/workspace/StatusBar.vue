<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { api } from '../api'
import { contextPressure, hitColor, setGlobalUsage, usageState } from '../workspace/usage'

const expanded = ref(false)
let timer: number | undefined

const pressure = computed(() => contextPressure())
const sessionHit = computed(() => usageState.session?.cache_hit_rate ?? 0)
const globalHit = computed(() => usageState.global?.cache_hit_rate ?? 0)
const cost = computed(() => usageState.session?.est_cost ?? usageState.global?.est_cost ?? 0)
const inTok = computed(() => usageState.session?.prompt_tokens ?? usageState.global?.prompt_tokens ?? 0)
const outTok = computed(() => usageState.session?.completion_tokens ?? usageState.global?.completion_tokens ?? 0)
const compacts = computed(() => usageState.session?.compact_count ?? usageState.global?.compact_count ?? 0)
const calls = computed(() => usageState.session?.llm_calls ?? usageState.global?.llm_calls ?? 0)

const preheatLabel = computed(() => {
  const p = usageState.preheat
  if (!p) return '—'
  if (p.last_error) return '失败'
  if (p.last_warm_ago === null) return '待预热'
  if (p.last_warm_ago < p.ttl_seconds) return `就绪 ${Math.round(p.last_warm_ago)}s`
  return `过期 ${Math.round(p.last_warm_ago / 60)}m`
})

const preheatTitle = computed(() => {
  const p = usageState.preheat
  if (!p) return ''
  return [
    `预热次数：${p.warm_count}`,
    `最近一次：${p.last_label || '—'}（${p.last_warm_ago ?? '—'} 秒前）`,
    `预热时命中 ${p.last_hit_tokens} token`,
    `预热累计成本 ¥${p.warm_cost.toFixed(6)}`,
    `新鲜期：${p.ttl_seconds}s（期内不重复预热）`,
    p.last_error ? `最近错误：${p.last_error}` : '',
  ]
    .filter(Boolean)
    .join('\n')
})

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

async function refresh() {
  try {
    const data = await api.chatUsage(usageState.sessionId || undefined)
    setGlobalUsage(data)
    usageState.apiOk = true
  } catch {
    usageState.apiOk = false
  }
}

onMounted(() => {
  refresh()
  timer = window.setInterval(refresh, 20000)
})
onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <footer class="statusbar">
    <div class="sb-left">
      <span class="sb-item" :title="usageState.apiOk ? '后端 API 正常' : '后端 API 未连接'">
        <i class="dot" :class="usageState.apiOk === false ? 'fail' : usageState.apiOk ? 'ok' : ''"></i>
        API
      </span>
      <span class="sb-item" title="当前模型与上下文窗口">🧠 {{ usageState.model || '—' }} · {{ (usageState.contextWindow / 1000).toFixed(0) }}k</span>
      <span v-if="usageState.sessionId" class="sb-item" title="当前会话">💬 {{ usageState.sessionId }}</span>
    </div>

    <div class="sb-center" :title="`上下文压力：最近一次输入 ${usageState.lastPromptTokens || inTok} tok / 窗口 ${usageState.contextWindow}`">
      <span class="sb-item">上下文</span>
      <span class="ctx-bar"><i class="ctx-fill" :style="{ width: pressure.pct + '%', background: pressure.color }"></i></span>
      <span class="sb-item">{{ pressure.pct }}%</span>
      <span v-if="usageState.compacting" class="sb-item warn">🗜️ 压缩中…</span>
    </div>

    <div class="sb-right">
      <span
        v-if="usageState.preheat?.enabled"
        class="sb-item"
        :title="preheatTitle"
      >
        🔥 预热 {{ preheatLabel }}
      </span>
      <span class="sb-item clickable" title="缓存命中率（命中 token / 全部输入 token）" @click="expanded = !expanded">
        <i class="dot" :style="{ background: hitColor(sessionHit || globalHit) }"></i>
        缓存命中 {{ ((sessionHit || globalHit) * 100).toFixed(1) }}%
      </span>
      <span class="sb-item" title="输入 / 输出 token">↑{{ fmtTokens(inTok) }} ↓{{ fmtTokens(outTok) }}</span>
      <span class="sb-item cost" title="估算成本（缓存价/未命中价/输出价）">¥{{ cost.toFixed(4) }}</span>
      <span class="sb-item" title="累计调用次数">⚙ {{ calls }}</span>
      <span class="sb-item" :class="{ warn: compacts > 0 }" title="上下文压缩次数">🗜️ {{ compacts }}</span>
      <button class="sb-toggle" :title="expanded ? '收起明细' : '展开明细'" @click="expanded = !expanded">
        {{ expanded ? '▾' : '▴' }}
      </button>
    </div>

    <!-- 展开明细 -->
    <div v-if="expanded" class="sb-detail">
      <div class="sd-col">
        <div class="sd-title">本会话</div>
        <div class="sd-row"><span>调用次数</span><b>{{ usageState.session?.llm_calls ?? 0 }}</b></div>
        <div class="sd-row"><span>输入 token</span><b>{{ (usageState.session?.prompt_tokens ?? 0).toLocaleString() }}</b></div>
        <div class="sd-row"><span>其中命中缓存</span><b class="ok-text">{{ (usageState.session?.cache_hit_tokens ?? 0).toLocaleString() }}</b></div>
        <div class="sd-row"><span>未命中</span><b>{{ (usageState.session?.cache_miss_tokens ?? 0).toLocaleString() }}</b></div>
        <div class="sd-row"><span>输出 token</span><b>{{ (usageState.session?.completion_tokens ?? 0).toLocaleString() }}</b></div>
        <div class="sd-row"><span>估算成本</span><b>¥{{ (usageState.session?.est_cost ?? 0).toFixed(6) }}</b></div>
        <div class="sd-row"><span>压缩次数</span><b>{{ usageState.session?.compact_count ?? 0 }}</b></div>
      </div>
      <div class="sd-col">
        <div class="sd-title">全部会话（累计）</div>
        <div class="sd-row"><span>会话数</span><b>{{ usageState.global?.sessions ?? 0 }}</b></div>
        <div class="sd-row"><span>调用次数</span><b>{{ usageState.global?.llm_calls ?? 0 }}</b></div>
        <div class="sd-row"><span>输入 token</span><b>{{ (usageState.global?.prompt_tokens ?? 0).toLocaleString() }}</b></div>
        <div class="sd-row"><span>缓存命中率</span><b :style="{ color: hitColor(globalHit) }">{{ (globalHit * 100).toFixed(1) }}%</b></div>
        <div class="sd-row"><span>输出 token</span><b>{{ (usageState.global?.completion_tokens ?? 0).toLocaleString() }}</b></div>
        <div class="sd-row"><span>累计成本</span><b>¥{{ (usageState.global?.est_cost ?? 0).toFixed(6) }}</b></div>
        <div class="sd-row"><span>累计压缩</span><b>{{ usageState.global?.compact_count ?? 0 }}</b></div>
      </div>
      <div class="sd-col">
        <div class="sd-title">成本机制</div>
        <div class="sd-note">
          缓存命中：相同前缀按缓存价计费（¥0.5/M）；未命中 ¥4/M；输出 ¥12/M。<br />
          上下文达窗口 {{ (usageState.contextWindow / 1000).toFixed(0) }}k 的 80% 时自动压缩历史为摘要，
          摘要调用复用已预热前缀以保住缓存命中。<br />
          预热：启动/新会话时用相同 system+tools 发最小请求，把静态前缀提前写入提供方缓存。
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  font-size: 11.5px;
  color: var(--text-sub);
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  z-index: 45;
}

.sb-left,
.sb-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sb-center {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.sb-right {
  margin-left: auto;
}

.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.sb-item.clickable {
  cursor: pointer;
}

.sb-item.warn {
  color: var(--warn);
}

.sb-item.cost {
  color: var(--text);
  font-weight: 600;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
}

.dot.ok {
  background: var(--ok);
}

.dot.fail {
  background: var(--danger);
}

.ctx-bar {
  width: 90px;
  height: 5px;
  border-radius: 999px;
  background: var(--border-soft);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}

.sb-toggle {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-sub);
  border-radius: 6px;
  width: 22px;
  height: 18px;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}

.sb-toggle:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* 明细面板 */
.sb-detail {
  position: fixed;
  right: 12px;
  bottom: 38px;
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
  gap: 18px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
  padding: 14px 16px;
  z-index: 46;
  max-width: min(760px, 94vw);
}

.sd-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
}

.sd-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  padding: 2px 0;
}

.sd-row b {
  color: var(--text);
}

.sd-note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-sub);
}

.ok-text {
  color: var(--ok);
}

@media (max-width: 900px) {
  .sb-center,
  .sb-item:not(.cost) {
    display: none;
  }
  .sb-detail {
    grid-template-columns: 1fr;
  }
}
</style>

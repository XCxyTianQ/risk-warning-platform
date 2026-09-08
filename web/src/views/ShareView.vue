<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { api, fmtTime } from '../api'

interface Msg {
  role: string
  content: string
  tool_calls: any[]
  tool_name: string
}

const route = useRoute()
const data = ref<{
  session_id: string
  title: string
  created_at: string
  updated_at: string
  usage: Record<string, number>
  messages: Msg[]
} | null>(null)
const error = ref('')
const loading = ref(true)

function render(text: string) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}

const turns = computed(() => {
  if (!data.value) return []
  const out: { user?: string; assistant: { text: string; tools: string[] }[] }[] = []
  let current: any = null
  for (const m of data.value.messages) {
    if (m.role === 'user') {
      current = { user: m.content, assistant: [] }
      out.push(current)
    } else if (m.role === 'assistant') {
      if (!current) {
        current = { assistant: [] }
        out.push(current)
      }
      const tools = (m.tool_calls || []).map((tc) => tc.function?.name).filter(Boolean)
      if (m.content || tools.length) current.assistant.push({ text: m.content, tools })
    } else if (m.role === 'tool' && current?.assistant?.length) {
      current.assistant[current.assistant.length - 1].tools.push(`↩ ${m.tool_name || 'tool'}`)
    }
  }
  return out
})

onMounted(async () => {
  try {
    data.value = await api.shared(String(route.params.token))
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="share-page">
    <header class="share-head">
      <div class="brand">
        <div class="brand-mark">险</div>
        <div>
          <div class="brand-name">企业经营风险预警平台</div>
          <div class="brand-sub">共享对话（只读）</div>
        </div>
      </div>
      <span class="badge">🔒 只读分享</span>
    </header>

    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state error">{{ error }}</div>

    <main v-else-if="data" class="share-body">
      <h1>{{ data.title }}</h1>
      <div class="meta">
        <span>会话 {{ data.session_id }}</span>
        <span>创建 {{ fmtTime(data.created_at) }}</span>
        <span>更新 {{ fmtTime(data.updated_at) }}</span>
        <span>LLM 调用 {{ data.usage.llm_calls }} 次</span>
        <span>缓存命中 {{ Math.round((data.usage.cache_hit_rate ?? 0) * 100) }}%</span>
      </div>

      <div v-for="(t, i) in turns" :key="i" class="turn">
        <div v-if="t.user" class="msg user">
          <div class="who">🧑 提问</div>
          <div class="bubble" v-html="render(t.user)"></div>
        </div>
        <div v-for="(a, j) in t.assistant" :key="j" class="msg assistant">
          <div class="who">🤖 助手</div>
          <div v-if="a.tools.length" class="tools">
            <span v-for="(tool, k) in a.tools" :key="k" class="tool">{{ tool }}</span>
          </div>
          <div v-if="a.text" class="bubble" v-html="render(a.text)"></div>
        </div>
      </div>

      <footer class="share-foot">
        由「企业经营风险预警平台」生成 · 数据来自公开信源，不构成投资建议
      </footer>
    </main>
  </div>
</template>

<style scoped>
.share-page {
  max-width: 860px;
  margin: 0 auto;
  padding: 20px 20px 60px;
}

.share-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-name {
  font-size: 14px;
  font-weight: 700;
}

.brand-sub {
  font-size: 11px;
  color: var(--text-sub);
}

.badge {
  font-size: 11px;
  color: var(--text-sub);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
}

.state {
  padding: 60px 0;
  text-align: center;
  color: var(--text-sub);
}

.state.error {
  color: var(--danger);
}

.share-body h1 {
  font-size: 20px;
  margin: 0 0 8px;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-sub);
  margin-bottom: 22px;
}

.turn {
  margin-bottom: 22px;
}

.msg {
  margin-bottom: 10px;
}

.who {
  font-size: 11.5px;
  color: var(--text-sub);
  margin-bottom: 5px;
}

.bubble {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 15px;
  font-size: 13.5px;
  line-height: 1.75;
  box-shadow: var(--shadow);
  word-break: break-word;
}

.msg.user .bubble {
  background: rgba(37, 99, 235, 0.06);
  border-color: rgba(37, 99, 235, 0.25);
}

.bubble :deep(h2),
.bubble :deep(h3),
.bubble :deep(h4) {
  margin: 10px 0 6px;
  font-size: 14px;
}

.bubble :deep(ul) {
  margin: 6px 0;
  padding-left: 18px;
}

.bubble :deep(code) {
  background: rgba(37, 99, 235, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.tool {
  font-size: 10.5px;
  color: var(--text-sub);
  border: 1px dashed var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-family: Consolas, monospace;
}

.share-foot {
  margin-top: 28px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-sub);
  text-align: center;
}
</style>

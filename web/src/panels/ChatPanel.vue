<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

import { api } from '../api'
import { openForTool, workspace } from '../workspace/store'
import { setSessionUsage, usageState } from '../workspace/usage'

interface Approval {
  id: string
  description: string
  status: 'pending' | 'approved' | 'rejected'
}

interface ToolCard {
  id: string
  name: string
  args: Record<string, any>
  readOnly?: boolean
  running: boolean
  result?: Record<string, any>
  opened?: string
  approval?: Approval
}

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  tools: ToolCard[]
  streaming?: boolean
  error?: string
  notice?: string
}

interface UsageStats {
  llm_calls: number
  prompt_tokens: number
  completion_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  cache_hit_rate: number
  est_cost: number
  compact_count: number
}

interface SessionRow {
  id: string
  title: string
  updated_at: string
  message_count: number
}

const messages = ref<ChatMsg[]>([])
const input = ref('')
const busy = ref(false)
const sessionId = ref<string | null>(null)
const listEl = ref<HTMLDivElement | null>(null)
const historyOpen = ref(false)
const sessions = ref<SessionRow[]>([])
const loadingHistory = ref(false)
const usage = ref<UsageStats | null>(null)
const presets = ref<{ id: number; name: string; description: string; enabled: boolean }[]>([])
const presetId = ref<number | null>(null)
let abort: AbortController | null = null

const SESSION_KEY = 'rw-chat-session'

const SUGGESTIONS = [
  '康美药业现在风险怎么样？',
  '平台里哪些企业是高风险？',
  '宁德时代和贵州茅台哪个更稳？',
  '整体情况怎么样，平均分多少？',
]

const TOOL_LABEL: Record<string, string> = {
  search_enterprise: '搜索企业',
  get_score_profile: '获取评分画像',
  get_risk_facts: '获取风险事实',
  list_enterprises_by_level: '按等级筛选',
  get_platform_overview: '平台总览',
  run_risk_analysis: '触发完整研判',
  refresh_enterprise_data: '数据源刷新',
  resolve_stock_code: '解析股票代码',
  add_enterprise: '添加企业',
  list_alerts: '查询预警',
  handle_alert: '处置预警',
  get_alert_report: '生成预警报告',
  list_skills: '查看技能',
  load_skill: '载入技能',
}

/** 动作工具审批 */
async function decide(card: ToolCard, approved: boolean) {
  if (!card.approval || card.approval.status !== 'pending') return
  try {
    await api.chatApprove(card.approval.id, approved)
    card.approval.status = approved ? 'approved' : 'rejected'
  } catch (e) {
    card.approval.status = 'rejected'
    card.result = { ok: false, error: (e as Error).message }
  }
}

async function scrollBottom() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

function render(text: string) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}

function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// ---------- 历史会话 ----------
async function loadSessions() {
  loadingHistory.value = true
  try {
    const r = await api.chatSessions()
    sessions.value = r.sessions
  } catch {
    sessions.value = []
  } finally {
    loadingHistory.value = false
  }
}

function rebuildMessages(rows: any[]): ChatMsg[] {
  const out: ChatMsg[] = []
  let current: ChatMsg | null = null
  for (const m of rows) {
    if (m.role === 'user') {
      out.push({ role: 'user', text: m.content, tools: [] })
      current = null
    } else if (m.role === 'assistant') {
      const calls: any[] = m.tool_calls ?? []
      if (calls.length) {
        const msg: ChatMsg = {
          role: 'assistant',
          text: m.content || '',
          tools: calls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name ?? '',
            args: safeParse(tc.function?.arguments ?? '{}'),
            running: false,
            readOnly: true,
          })),
        }
        out.push(msg)
        current = msg
      } else if (m.content) {
        out.push({ role: 'assistant', text: m.content, tools: [] })
        current = null
      }
    } else if (m.role === 'tool' && current) {
      const card = current.tools.find((t) => t.id === m.tool_call_id)
      if (card) card.result = safeParse(m.content)
    }
  }
  return out
}

async function openSession(id: string) {
  historyOpen.value = false
  busy.value = false
  try {
    const r = await api.chatSession(id)
    sessionId.value = r.session_id
    localStorage.setItem(SESSION_KEY, r.session_id)
    messages.value = rebuildMessages(r.messages)
    usage.value = (r as any).usage ?? null
    setSessionUsage(usage.value, r.session_id)
    await scrollBottom()
  } catch (e) {
    messages.value = [{ role: 'assistant', text: '', tools: [], error: (e as Error).message }]
  }
}

async function deleteSession(id: string) {
  await api.chatDelete(id)
  if (sessionId.value === id) reset()
  await loadSessions()
}

function newChat() {
  stop()
  messages.value = []
  sessionId.value = null
  localStorage.removeItem(SESSION_KEY)
}

function reset() {
  newChat()
}

onMounted(async () => {
  const savedPreset = localStorage.getItem('rw-preset')
  if (savedPreset) presetId.value = Number(savedPreset) || null
  try {
    presets.value = (await api.presets()).items.filter((p) => p.enabled)
  } catch {
    presets.value = []
  }
  const saved = localStorage.getItem(SESSION_KEY)
  if (saved) await openSession(saved)
  await loadSessions()
})

function onPresetChange() {
  localStorage.setItem('rw-preset', presetId.value ? String(presetId.value) : '')
}

async function send(text?: string) {
  const content = (text ?? input.value).trim()
  if (!content || busy.value) return
  input.value = ''
  busy.value = true
  messages.value.push({ role: 'user', text: content, tools: [] })
  const reply: ChatMsg = { role: 'assistant', text: '', tools: [], streaming: true }
  messages.value.push(reply)
  await scrollBottom()

  abort = new AbortController()
  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content, session_id: sessionId.value, preset_id: presetId.value }),
      signal: abort.signal,
    })
    if (!resp.body) throw new Error('服务端未返回流')
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const blocks = buf.split('\n\n')
      buf = blocks.pop() ?? ''
      for (const block of blocks) {
        const evLine = block.split('\n').find((l) => l.startsWith('event: '))
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
        if (!evLine || !dataLine) continue
        let data: any = {}
        try {
          data = JSON.parse(dataLine.slice(6))
        } catch {
          continue
        }
        handleEvent(evLine.slice(7).trim(), data, reply)
        await scrollBottom()
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') reply.error = (e as Error).message
  } finally {
    reply.streaming = false
    busy.value = false
    abort = null
    await scrollBottom()
  }
}

function handleEvent(event: string, data: any, reply: ChatMsg) {
  if (event === 'session') {
    sessionId.value = data.session_id
    localStorage.setItem(SESSION_KEY, data.session_id)
  } else if (event === 'token') {
    reply.text += data.text ?? ''
  } else if (event === 'tool') {
    reply.tools.push({
      id: data.id,
      name: data.name,
      args: data.args ?? {},
      readOnly: data.read_only,
      running: true,
    })
  } else if (event === 'tool_result') {
    const card = reply.tools.find((t) => t.id === data.id)
    if (card) {
      card.running = false
      card.result = data.result
      // ★ Agent ↔ 界面协作：按工具结果自动在画布开窗
      const before = workspace.panels.length
      openForTool(card.name, data.result)
      if (workspace.panels.length > before) card.opened = '已在新面板打开'
      else if (card.name === 'get_score_profile' || card.name === 'run_risk_analysis') card.opened = '已更新画像面板'
    }
  } else if (event === 'approval') {
    const card = reply.tools.find((t) => t.id === data.id)
    if (card) {
      card.approval = { id: data.approval_id, description: data.description, status: 'pending' }
    }
  } else if (event === 'usage') {
    usage.value = {
      llm_calls: data.llm_calls ?? 0,
      prompt_tokens: data.prompt_tokens ?? 0,
      completion_tokens: data.completion_tokens ?? 0,
      cache_hit_tokens: data.cache_hit_tokens ?? 0,
      cache_miss_tokens: data.cache_miss_tokens ?? 0,
      cache_hit_rate: data.cache_hit_rate ?? 0,
      est_cost: data.est_cost ?? 0,
      compact_count: data.compact_count ?? 0,
    }
    setSessionUsage(usage.value, sessionId.value ?? '')
    usageState.lastPromptTokens = data.call?.prompt_tokens ?? usageState.lastPromptTokens
    usageState.compacting = false
  } else if (event === 'compaction') {
    if (data.phase === 'start') {
      reply.notice = `上下文接近上限（约 ${data.estimated_tokens} tok / 窗口 ${data.window}），正在压缩历史…`
      usageState.compacting = true
    } else if (data.phase === 'done') {
      reply.notice = `已压缩 ${data.folded} 条历史消息为摘要，上下文已收敛（累计压缩 ${data.compact_count} 次）`
      usageState.compacting = false
      if (data.usage) {
        usage.value = { ...(usage.value as any), ...data.usage }
        setSessionUsage(usage.value, sessionId.value ?? '')
      }
    } else {
      usageState.compacting = false
    }
  } else if (event === 'error') {
    reply.error = data.message
  } else if (event === 'done') {
    reply.streaming = false
    if (data.usage) {
      usage.value = data.usage
      setSessionUsage(data.usage, sessionId.value ?? '')
    }
    loadSessions()
  }
}

function stop() {
  abort?.abort()
  busy.value = false
}
</script>

<template>
  <div class="chat-panel">
    <div class="chat-toolbar">
      <div class="tb-left">
        <button class="btn ghost small" @click="historyOpen = !historyOpen">
          🕘 历史会话 {{ sessions.length ? `(${sessions.length})` : '' }}
        </button>
        <span class="session" v-if="sessionId">会话 {{ sessionId }}</span>
        <span
          v-if="usage && usage.llm_calls"
          class="usage"
          :title="`调用 ${usage.llm_calls} 次 · 输入 ${usage.prompt_tokens} tok（命中 ${usage.cache_hit_tokens} / 未命中 ${usage.cache_miss_tokens}）· 输出 ${usage.completion_tokens} tok${usage.compact_count ? ` · 压缩 ${usage.compact_count} 次` : ''}`"
        >
          💰 缓存命中 {{ Math.round((usage.cache_hit_rate ?? 0) * 100) }}%
          · {{ ((usage.prompt_tokens + usage.completion_tokens) / 1000).toFixed(1) }}k tok
          <template v-if="usage.compact_count"> · 已压缩 {{ usage.compact_count }} 次</template>
        </span>
      </div>
      <button class="btn ghost small" @click="newChat">＋ 新对话</button>
    </div>

    <div class="preset-bar">
      <span class="pb-label">🧩 预设</span>
      <select v-model="presetId" class="preset-select" @change="onPresetChange">
        <option :value="null">通用（默认）</option>
        <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <span class="pb-desc">{{ presets.find((p) => p.id === presetId)?.description ?? '全工具、全技能' }}</span>
    </div>

    <!-- 历史会话列表 -->
    <div v-if="historyOpen" class="history">
      <div v-if="loadingHistory" class="history-empty">加载中…</div>
      <div v-else-if="!sessions.length" class="history-empty">还没有历史会话</div>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="history-item"
        :class="{ current: s.id === sessionId }"
        @click="openSession(s.id)"
      >
        <div class="hi-main">
          <div class="hi-title">{{ s.title }}</div>
          <div class="hi-meta">{{ s.message_count }} 条消息 · {{ new Date(s.updated_at).toLocaleString('zh-CN', { hour12: false }) }}</div>
        </div>
        <button class="hi-del" title="删除" @click.stop="deleteSession(s.id)">✕</button>
      </div>
    </div>

    <div ref="listEl" class="chat-list">
      <div v-if="!messages.length" class="welcome">
        <div class="welcome-mark">险</div>
        <p class="welcome-title">你好，我是险小e</p>
        <p class="welcome-sub">问我企业风险，我会自动取数、评分、找证据，并把结果开成新面板。</p>
        <div class="suggests">
          <button v-for="s in SUGGESTIONS" :key="s" class="suggest" @click="send(s)">{{ s }}</button>
        </div>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div v-if="m.role === 'assistant'" class="avatar">险</div>
        <div class="bubble-wrap">
          <div v-for="t in m.tools" :key="t.id" class="tool-card" :class="{ running: t.running }">
            <div class="tool-head">
              <span>{{ t.running ? '⏳' : t.result?.ok === false ? '⚠️' : '🔧' }}</span>
              <span class="tool-name">{{ TOOL_LABEL[t.name] ?? t.name }}</span>
              <code class="tool-args">{{ JSON.stringify(t.args) }}</code>
              <span v-if="t.readOnly === false" class="tool-tag">动作</span>
            </div>
            <div v-if="t.result" class="tool-result">
              <template v-if="t.result.ok === false">
                <span class="fail-text">{{ t.result.error }}</span>
              </template>
              <template v-else>
                <span v-if="t.result.count !== undefined">{{ t.result.count }} 条</span>
                <span v-if="t.result.score !== undefined"> · {{ t.result.score }} 分（{{ t.result.grade }}）</span>
                <span v-if="t.result.enterprise_total !== undefined"> · {{ t.result.enterprise_total }} 家企业，平均 {{ t.result.avg_score }} 分</span>
                <ul v-if="t.result.enterprises" class="tool-items">
                  <li v-for="e in t.result.enterprises" :key="e.name">{{ e.name }} — {{ e.score }} 分（{{ e.grade }}）</li>
                </ul>
              </template>
              <span v-if="t.opened" class="opened-tag">↗ {{ t.opened }}</span>
            </div>

            <!-- 动作工具审批（Harness approval） -->
            <div v-if="t.approval" class="approval" :class="t.approval.status">
              <div class="ap-text">
                <b>需要授权：</b>{{ t.approval.description }}
              </div>
              <div v-if="t.approval.status === 'pending'" class="ap-actions">
                <button class="btn primary small" @click="decide(t, true)">允许执行</button>
                <button class="btn ghost small" @click="decide(t, false)">拒绝</button>
              </div>
              <div v-else class="ap-status">
                {{ t.approval.status === 'approved' ? '✅ 已授权执行' : '🚫 已拒绝（操作未执行）' }}
              </div>
            </div>
          </div>

          <div v-if="m.text" class="bubble" v-html="render(m.text)"></div>
          <div v-else-if="m.streaming && !m.tools.length" class="bubble typing"><i></i><i></i><i></i></div>
          <div v-if="m.notice" class="notice">🗜️ {{ m.notice }}</div>
          <div v-if="m.error" class="bubble error-bubble">{{ m.error }}</div>
        </div>
      </div>
    </div>

    <div class="composer">
      <textarea
        v-model="input"
        rows="2"
        placeholder="提问…（Enter 发送）"
        @keydown.enter.exact.prevent="send()"
      ></textarea>
      <button v-if="busy" class="btn ghost" @click="stop">停止</button>
      <button v-else class="btn primary" :disabled="!input.trim()" @click="send()">发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.chat-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
  margin-bottom: 10px;
}

.tb-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session {
  font-size: 11px;
  color: var(--text-sub);
}

.preset-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0 8px;
  border-bottom: 1px dashed var(--border);
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.pb-label {
  font-size: 11.5px;
  color: var(--text-sub);
}

.preset-select {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.preset-select:focus {
  border-color: var(--primary);
}

.pb-desc {
  font-size: 11px;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage {
  font-size: 11px;
  color: var(--text-sub);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 9px;
  background: var(--hover);
  cursor: help;
  white-space: nowrap;
}

.notice {  font-size: 11.5px;
  color: var(--warn);
  background: rgba(217, 119, 6, 0.08);
  border: 1px solid rgba(217, 119, 6, 0.3);
  border-radius: 8px;
  padding: 6px 10px;
}

/* 历史会话 */
.history {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 10px;
  padding: 4px;
}

.history-empty {
  padding: 12px;
  font-size: 12px;
  color: var(--text-sub);
  text-align: center;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
}

.history-item:hover {
  background: var(--hover);
}

.history-item.current {
  background: rgba(37, 99, 235, 0.08);
}

.hi-main {
  flex: 1;
  min-width: 0;
}

.hi-title {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hi-meta {
  font-size: 10.5px;
  color: var(--text-sub);
}

.hi-del {
  border: none;
  background: transparent;
  color: var(--text-sub);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 5px;
  border-radius: 4px;
}

.hi-del:hover {
  color: var(--danger);
  background: rgba(220, 38, 38, 0.08);
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 4px;
}

.welcome {
  margin: auto;
  text-align: center;
  max-width: 420px;
}

.welcome-mark {
  width: 44px;
  height: 44px;
  margin: 0 auto 10px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.welcome-title {
  font-weight: 700;
  margin: 0 0 4px;
}

.welcome-sub {
  font-size: 12px;
  color: var(--text-sub);
  margin: 0 0 14px;
}

.suggests {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.suggest {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.suggest:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.msg {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.msg.user {
  justify-content: flex-end;
}

.avatar {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bubble-wrap {
  max-width: 86%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.msg.user .bubble-wrap {
  align-items: flex-end;
}

.bubble {
  background: var(--hover);
  border-radius: 12px;
  padding: 10px 13px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}

.bubble :deep(h3),
.bubble :deep(h4) {
  margin: 8px 0 5px;
  font-size: 13.5px;
}

.bubble :deep(ul) {
  margin: 5px 0;
  padding-left: 17px;
}

.bubble :deep(code) {
  background: rgba(37, 99, 235, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11.5px;
}

.msg.user .bubble {
  background: linear-gradient(135deg, var(--primary), var(--primary-deep));
  color: #fff;
}

.error-bubble {
  background: rgba(220, 38, 38, 0.1);
  color: var(--danger);
  font-size: 12px;
}

.typing {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 12px 14px;
}

.typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-sub);
  animation: blink 1.2s infinite;
}

.typing i:nth-child(2) { animation-delay: 0.2s; }
.typing i:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

.tool-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  background: var(--bg-elev);
  border-radius: 8px;
  padding: 7px 11px;
  font-size: 11.5px;
}

.tool-card.running {
  border-left-color: var(--warn);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.tool-name {
  font-weight: 600;
}

.tool-args {
  color: var(--text-sub);
  font-size: 10.5px;
  background: var(--hover);
  border-radius: 4px;
  padding: 1px 5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-tag {
  font-size: 10px;
  color: var(--warn);
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 5px;
}

.tool-result {
  margin-top: 5px;
  color: var(--text-sub);
}

.tool-items {
  margin: 4px 0 0;
  padding-left: 15px;
}

.opened-tag {
  display: inline-block;
  margin-left: 6px;
  color: var(--primary);
  font-weight: 600;
}

/* 动作审批 */
.approval {
  margin-top: 7px;
  border: 1px solid rgba(217, 119, 6, 0.45);
  background: rgba(217, 119, 6, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
}

.approval.approved {
  border-color: rgba(22, 163, 74, 0.45);
  background: rgba(22, 163, 74, 0.08);
}

.approval.rejected {
  border-color: var(--border);
  background: var(--hover);
}

.ap-text {
  font-size: 11.5px;
  color: var(--text);
  margin-bottom: 6px;
}

.ap-actions {
  display: flex;
  gap: 6px;
}

.ap-status {
  font-size: 11.5px;
  font-weight: 600;
}

.composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  margin-top: 10px;
}

.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 11px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
}

.composer textarea:focus {
  border-color: var(--primary);
}
</style>

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
  latencyMs?: number
}

interface ChatAttachment {
  id: string
  filename: string
  kind: string
  size: number
  preview_url: string
  reading_status?: string
  uploading?: boolean
}

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  tools: ToolCard[]
  attachments?: ChatAttachment[]
  streaming?: boolean
  error?: string
  notice?: string
  reasoning?: string        // 推理型模型的思考过程（reasoning_content）
  reasoningOpen?: boolean
  elapsedMs?: number       // 本轮端到端耗时
  timing?: { latency_ms: number; ttft_ms: number; tokens_per_sec: number; completion_tokens: number }
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
  pinned: boolean
  updated_at: string
  created_at: string
  message_count: number
  cache_hit_rate: number
  shared: boolean
}

const messages = ref<ChatMsg[]>([])
const input = ref('')
const busy = ref(false)
const sessionId = ref<string | null>(null)
const listEl = ref<HTMLDivElement | null>(null)
const historyOpen = ref(false)
// 待发送附件（粘贴/拖拽/选择）——图片会先在前端压缩再上传
const pending = ref<ChatAttachment[]>([])
const uploading = ref(false)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const sessions = ref<SessionRow[]>([])
const loadingHistory = ref(false)
const usage = ref<UsageStats | null>(null)
const toast = ref('')
const error = ref('')
const presets = ref<{ id: number; name: string; description: string; enabled: boolean }[]>([])
const presetId = ref<number | null>(null)
let abort: AbortController | null = null

const SESSION_KEY = 'rw-chat-session'

const SUGGESTIONS = [
  '康美药业现在风险怎么样？',
  '600518 的财务分析给我看看',
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

/** 毫秒 → 可读耗时（如 850ms / 2.3s / 1m05s） */
function fmtMs(ms?: number | null) {
  if (ms === undefined || ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  return `${m}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`
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
const searchQ = ref('')

async function loadSessions() {
  loadingHistory.value = true
  try {
    const r = await api.chatSessions(searchQ.value.trim())
    sessions.value = r.sessions
  } catch {
    sessions.value = []
  } finally {
    loadingHistory.value = false
  }
}

async function togglePin(s: SessionRow) {
  await api.chatPatch(s.id, { pinned: !s.pinned })
  await loadSessions()
}

async function renameSession(s: SessionRow) {
  const title = prompt('重命名会话', s.title)
  if (title === null) return
  await api.chatPatch(s.id, { title })
  await loadSessions()
}

async function removeSession(s: SessionRow) {
  if (!confirm(`删除会话「${s.title}」？该操作不可恢复。`)) return
  await api.chatDelete(s.id)
  if (sessionId.value === s.id) newChat()
  await loadSessions()
}

function exportSession(s: SessionRow, format: 'md' | 'json') {
  window.open(api.chatExportUrl(s.id, format), '_blank')
}

async function shareSession(s: SessionRow) {
  try {
    const r = await api.chatShare(s.id)
    const url = `${location.origin}${r.url}`
    await navigator.clipboard?.writeText(url).catch(() => {})
    toast.value = `分享链接已复制：${url}`
    await loadSessions()
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 8000)
}

async function revokeShare(s: SessionRow) {
  await api.chatRevokeShare(s.id)
  toast.value = '已撤销分享'
  await loadSessions()
  setTimeout(() => (toast.value = ''), 3000)
}

async function importSessionFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const r = await api.chatImport(JSON.parse(text))
    toast.value = `已导入会话「${r.title}」（${r.messages} 条消息）`
    await loadSessions()
    await openSession(r.session_id)
  } catch (err) {
    error.value = (err as Error).message
  }
  setTimeout(() => (toast.value = ''), 5000)
}

async function clearCurrent() {
  if (!sessionId.value) return
  if (!confirm('清空当前会话的全部消息？（会话本身保留）')) return
  await api.chatClear(sessionId.value)
  messages.value = []
  usage.value = null
  await loadSessions()
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

function newChat() {
  stop()
  messages.value = []
  sessionId.value = null
  localStorage.removeItem(SESSION_KEY)
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

// ---------- 多模态输入：粘贴 / 拖拽 / 选择图片 ----------

/** 前端压缩：长边 ≤1600、JPEG 0.82 —— 明显省 token，也让上传更快 */
async function compressImage(file: File): Promise<{ data: string; mime: string; filename: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })
  if (file.type === 'image/gif') return { data: dataUrl, mime: file.type, filename: file.name }
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解码失败'))
      el.src = dataUrl
    })
    const maxSide = 1600
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return { data: dataUrl, mime: file.type, filename: file.name }
    ctx.drawImage(img, 0, 0, w, h)
    const out = canvas.toDataURL('image/jpeg', 0.82)
    return { data: out, mime: 'image/jpeg', filename: file.name.replace(/\.(png|webp|bmp)$/i, '.jpg') }
  } catch {
    return { data: dataUrl, mime: file.type || 'image/png', filename: file.name }
  }
}

async function uploadFiles(files: File[]) {
  if (!files.length) return
  uploading.value = true
  try {
    for (const file of files) {
      const isImage = file.type.startsWith('image/')
      const placeholder: ChatAttachment = {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        filename: file.name,
        kind: isImage ? 'image' : 'file',
        size: file.size,
        preview_url: '',
        uploading: true,
      }
      pending.value.push(placeholder)
      try {
        let body: any
        if (isImage) {
          const { data, mime, filename } = await compressImage(file)
          body = { filename, mime, data_base64: data, session_id: sessionId.value ?? '', origin: 'paste' }
        } else {
          const buf = await file.arrayBuffer()
          let bin = ''
          const bytes = new Uint8Array(buf)
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          body = { filename: file.name, mime: file.type || 'application/octet-stream', data_base64: btoa(bin), session_id: sessionId.value ?? '', origin: 'upload' }
        }
        const r = await api.uploadAttachment(body)
        const att = r.attachment as ChatAttachment
        Object.assign(placeholder, att, { uploading: false })
      } catch (e) {
        pending.value = pending.value.filter((p) => p.id !== placeholder.id)
        error.value = `附件上传失败：${(e as Error).message}`
      }
    }
  } finally {
    uploading.value = false
  }
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length) {
    e.preventDefault()
    void uploadFiles(files)
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) void uploadFiles(files)
}

function pickFiles() {
  fileInput.value?.click()
}

function onPickFiles(e: Event) {
  const el = e.target as HTMLInputElement
  void uploadFiles(Array.from(el.files ?? []))
  el.value = ''
}

function removePending(id: string) {
  pending.value = pending.value.filter((p) => p.id !== id)
}

async function send(text?: string) {
  const content = (text ?? input.value).trim()
  if ((!content && !pending.value.length) || busy.value) return
  const sent = pending.value.filter((p) => !p.uploading).map((p) => ({ ...p }))
  const attachmentIds = sent.map((a) => a.id)
  input.value = ''
  pending.value = []
  busy.value = true
  messages.value.push({ role: 'user', text: content, tools: [], attachments: sent.length ? sent : undefined })
  const reply: ChatMsg = { role: 'assistant', text: '', tools: [], streaming: true, reasoningOpen: true }
  messages.value.push(reply)
  await scrollBottom()

  const startedAt = Date.now()
  const ticker = window.setInterval(() => {
    if (reply.streaming) reply.elapsedMs = Date.now() - startedAt
  }, 200)

  abort = new AbortController()
  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: content,
        session_id: sessionId.value,
        preset_id: presetId.value,
        attachment_ids: attachmentIds,
      }),
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
    reply.elapsedMs = Date.now() - startedAt
    if (reply.reasoning) reply.reasoningOpen = false
    window.clearInterval(ticker)
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
  } else if (event === 'reasoning') {
    reply.reasoning = (reply.reasoning ?? '') + (data.text ?? '')
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
      card.latencyMs = data.latency_ms
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
    if (data.timing) reply.timing = data.timing
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
      <div class="tb-actions">
        <button class="btn ghost small" :disabled="!sessionId" @click="shareSession({ id: sessionId } as SessionRow)">🔗 分享</button>
        <button class="btn ghost small" :disabled="!sessionId" @click="clearCurrent">🧹 清空</button>
        <button class="btn ghost small" @click="newChat">＋ 新对话</button>
      </div>
    </div>

    <div class="preset-bar">
      <span class="pb-label">🧩 预设</span>
      <select v-model="presetId" class="preset-select" @change="onPresetChange">
        <option :value="null">通用（默认）</option>
        <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <span class="pb-desc">{{ presets.find((p) => p.id === presetId)?.description ?? '全工具、全技能' }}</span>
    </div>

    <!-- 历史会话列表（对话管理） -->
    <div v-if="historyOpen" class="history">
      <div class="history-search">
        <input v-model="searchQ" placeholder="搜索标题或消息内容…" @input="loadSessions" />
        <label class="btn ghost small import-btn">
          ⤒ 导入
          <input type="file" accept="application/json,.json" @change="importSessionFile" />
        </label>
      </div>
      <div v-if="loadingHistory" class="history-empty">加载中…</div>
      <div v-else-if="!sessions.length" class="history-empty">没有匹配的会话</div>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="history-item"
        :class="{ current: s.id === sessionId }"
        @click="openSession(s.id)"
      >
        <button class="hi-pin" :class="{ on: s.pinned }" :title="s.pinned ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
        <div class="hi-main">
          <div class="hi-title">
            {{ s.title }}
            <span v-if="s.shared" class="hi-tag">已分享</span>
          </div>
          <div class="hi-meta">
            {{ s.message_count }} 条 · 命中 {{ Math.round((s.cache_hit_rate ?? 0) * 100) }}% ·
            {{ new Date(s.updated_at).toLocaleString('zh-CN', { hour12: false }) }}
          </div>
        </div>
        <div class="hi-actions">
          <button class="hi-btn" title="重命名" @click.stop="renameSession(s)">✎</button>
          <button class="hi-btn" title="导出 Markdown" @click.stop="exportSession(s, 'md')">MD</button>
          <button class="hi-btn" title="导出 JSON" @click.stop="exportSession(s, 'json')">JSON</button>
          <button v-if="!s.shared" class="hi-btn" title="生成分享链接" @click.stop="shareSession(s)">🔗</button>
          <button v-else class="hi-btn" title="撤销分享" @click.stop="revokeShare(s)">🚫</button>
          <button class="hi-del" title="删除" @click.stop="removeSession(s)">✕</button>
        </div>
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
          <!-- 推理型模型的思考过程（先于正文到达，减少"黑屏等待"） -->
          <div v-if="m.reasoning" class="reasoning" :class="{ live: m.streaming }">
            <button class="reasoning-head" @click="m.reasoningOpen = !m.reasoningOpen">
              <span>{{ m.streaming ? '🧠 正在思考…' : '🧠 思考过程' }}</span>
              <span class="reasoning-meta">{{ m.reasoning.length }} 字 {{ m.reasoningOpen ? '▾' : '▸' }}</span>
            </button>
            <div v-if="m.reasoningOpen" class="reasoning-body">{{ m.reasoning }}</div>
          </div>

          <div v-for="t in m.tools" :key="t.id" class="tool-card" :class="{ running: t.running }">
            <div class="tool-head">
              <span>{{ t.running ? '⏳' : t.result?.ok === false ? '⚠️' : '🔧' }}</span>
              <span class="tool-name">{{ TOOL_LABEL[t.name] ?? t.name }}</span>
              <code class="tool-args">{{ JSON.stringify(t.args) }}</code>
              <span v-if="t.readOnly === false" class="tool-tag">动作</span>
              <span v-if="t.latencyMs !== undefined" class="tool-ms">{{ fmtMs(t.latencyMs) }}</span>
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

          <div v-if="m.attachments?.length" class="msg-atts">
            <a
              v-for="a in m.attachments"
              :key="a.id"
              class="msg-att"
              :href="api.attachmentUrl(a.id)"
              target="_blank"
              rel="noopener"
              :title="a.filename"
            >
              <img v-if="a.kind === 'image'" :src="api.attachmentUrl(a.id)" :alt="a.filename" />
              <span v-else class="file-chip">📄 {{ a.filename }}</span>
            </a>
          </div>
          <div v-if="m.text" class="bubble" v-html="render(m.text)"></div>
          <div v-else-if="m.streaming && !m.tools.length" class="bubble typing"><i></i><i></i><i></i></div>
          <div v-if="m.streaming && m.elapsedMs" class="stream-timer">⏱ 已用时 {{ fmtMs(m.elapsedMs) }}</div>
          <div v-if="m.notice" class="notice">🗜️ {{ m.notice }}</div>
          <div v-if="m.error" class="bubble error-bubble">{{ m.error }}</div>
          <div v-if="!m.streaming && (m.elapsedMs || m.timing)" class="msg-foot">
            <span v-if="m.elapsedMs">⏱ {{ fmtMs(m.elapsedMs) }}</span>
            <span v-if="m.timing">首字 {{ fmtMs(m.timing.ttft_ms) }}</span>
            <span v-if="m.timing && m.timing.tokens_per_sec">{{ m.timing.tokens_per_sec }} tok/s</span>
            <span v-if="m.timing">末次输出 {{ m.timing.completion_tokens }} tok</span>
          </div>
        </div>
      </div>
    </div>

    <div
      class="composer"
      :class="{ 'drag-over': dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <!-- 待发送附件（粘贴/拖拽/选择） -->
      <div v-if="pending.length" class="pending">
        <div v-for="a in pending" :key="a.id" class="chip" :class="{ busy: a.uploading }">
          <img v-if="a.kind === 'image' && !a.uploading" :src="api.attachmentUrl(a.id)" :alt="a.filename" />
          <span v-else class="chip-ph">{{ a.uploading ? '⏳' : '📄' }}</span>
          <span class="chip-name">{{ a.filename }}</span>
          <i title="移除" @click="removePending(a.id)">✕</i>
        </div>
        <span v-if="uploading" class="chip-hint">上传中…</span>
      </div>

      <textarea
        v-model="input"
        rows="2"
        placeholder="提问…（Enter 发送；可直接粘贴截图或拖入图片/表格文件）"
        @keydown.enter.exact.prevent="send()"
        @paste="onPaste"
      ></textarea>
      <input ref="fileInput" type="file" multiple accept="image/*,.csv,.xlsx,.xls" hidden @change="onPickFiles" />
      <button class="btn ghost attach-btn" title="添加图片或表格文件" @click="pickFiles">📎</button>
      <button v-if="busy" class="btn ghost" @click="stop">停止</button>
      <button v-else class="btn primary" :disabled="(!input.trim() && !pending.length) || uploading" @click="send()">发送</button>
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

.notice {  font-size: 11.5px;  color: var(--warn);
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

.history-search {
  display: flex;
  gap: 8px;
  padding: 4px 6px 8px;
}

.history-search input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  background: var(--card);
  color: var(--text);
  outline: none;
}

.history-search input:focus {
  border-color: var(--primary);
}

.import-btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
}

.import-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.hi-pin {
  border: none;
  background: transparent;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.35;
  padding: 2px;
}

.hi-pin.on {
  opacity: 1;
}

.hi-tag {
  font-size: 10px;
  color: var(--primary);
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 4px;
}

.hi-actions {
  display: flex;
  gap: 3px;
  align-items: center;
  flex: none;
}

.hi-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-sub);
  border-radius: 5px;
  font-size: 10px;
  padding: 1px 5px;
  cursor: pointer;
  line-height: 16px;
}

.hi-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.tb-actions {
  display: flex;
  gap: 6px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 6px;
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
  flex-wrap: wrap;
  border-radius: 10px;
}

.composer.drag-over {
  outline: 2px dashed var(--primary);
  outline-offset: 4px;
}

.pending {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  align-items: center;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px 6px 3px 4px;
  background: var(--bg-elev);
  max-width: 220px;
}

.chip.busy { opacity: 0.7; }

.chip img {
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: 5px;
}

.chip-ph { font-size: 16px; }

.chip-name {
  font-size: 11px;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip i {
  font-style: normal;
  cursor: pointer;
  color: var(--text-sub);
  font-size: 10.5px;
}

.chip i:hover { color: #dc2626; }

.chip-hint { font-size: 11px; color: var(--text-sub); }

.attach-btn { padding: 6px 9px; }

.msg-atts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.msg-att img {
  width: 132px;
  max-height: 132px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border);
  display: block;
}

.file-chip {
  display: inline-block;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  background: var(--bg-elev);
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

/* ---------- 思考过程 / 耗时展示 ---------- */
.reasoning {
  margin-bottom: 8px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--hover);
  overflow: hidden;
}

.reasoning.live {
  border-color: var(--primary);
}

.reasoning-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text-sub);
  font-size: 11.5px;
  cursor: pointer;
  font-family: inherit;
}

.reasoning-head:hover {
  color: var(--text);
}

.reasoning-meta {
  font-size: 11px;
}

.reasoning-body {
  max-height: 180px;
  overflow-y: auto;
  padding: 0 10px 8px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-sub);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-ms {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-sub);
  white-space: nowrap;
}

.stream-timer {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-sub);
}

.msg-foot {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-sub);
}
</style>

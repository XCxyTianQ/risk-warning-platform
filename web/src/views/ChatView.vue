<script setup lang="ts">
import { nextTick, ref } from 'vue'

interface ToolCard {
  id: string
  name: string
  args: Record<string, any>
  readOnly?: boolean
  running: boolean
  result?: Record<string, any>
}

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  tools: ToolCard[]
  streaming?: boolean
  error?: string
}

const messages = ref<ChatMsg[]>([])
const input = ref('')
const busy = ref(false)
const sessionId = ref<string | null>(null)
const listEl = ref<HTMLDivElement | null>(null)
let abort: AbortController | null = null

const SUGGESTIONS = [
  '康美药业现在风险怎么样？简要说明依据',
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
}

async function scrollBottom() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

/** 极简 markdown 渲染（先转义再替换，避免 XSS） */
function render(text: string) {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
      body: JSON.stringify({ message: content, session_id: sessionId.value }),
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
        const event = evLine.slice(7).trim()
        let data: any = {}
        try {
          data = JSON.parse(dataLine.slice(6))
        } catch {
          continue
        }
        handleEvent(event, data, reply)
        await scrollBottom()
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      reply.error = (e as Error).message
    }
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
    }
  } else if (event === 'error') {
    reply.error = data.message
  } else if (event === 'done') {
    reply.streaming = false
  }
}

function stop() {
  abort?.abort()
  busy.value = false
}

function reset() {
  stop()
  messages.value = []
  sessionId.value = null
}
</script>

<template>
  <div class="chat-page">
    <div class="page-head">
      <div>
        <h2>智能问答</h2>
        <p class="page-sub">用自然语言提问，Agent 自动调用工具取数、评分、找证据后回答（多轮对话）</p>
      </div>
      <button v-if="messages.length" class="btn ghost small" @click="reset">清空对话</button>
    </div>

    <div class="chat-card">
      <div ref="listEl" class="chat-list">
        <!-- 空态 -->
        <div v-if="!messages.length" class="welcome">
          <div class="welcome-mark">险</div>
          <h3>你好，我是险小e</h3>
          <p>我可以查询企业风险画像、对比企业、触发研判、汇总平台情况。试试下面的问题：</p>
          <div class="suggests">
            <button v-for="s in SUGGESTIONS" :key="s" class="suggest" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <!-- 消息 -->
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div v-if="m.role === 'assistant'" class="avatar">险</div>
          <div class="bubble-wrap">
            <!-- 工具调用卡片 -->
            <div v-for="t in m.tools" :key="t.id" class="tool-card" :class="{ running: t.running }">
              <div class="tool-head">
                <span class="tool-icon">{{ t.running ? '⏳' : t.result?.ok === false ? '⚠️' : '🔧' }}</span>
                <span class="tool-name">{{ TOOL_LABEL[t.name] ?? t.name }}</span>
                <code class="tool-args">{{ JSON.stringify(t.args) }}</code>
                <span v-if="t.readOnly === false" class="tool-tag">动作</span>
              </div>
              <div v-if="t.result" class="tool-result">
                <template v-if="t.result.ok === false">
                  <span class="fail-text">{{ t.result.error }}</span>
                </template>
                <template v-else>
                  <span v-if="t.result.count !== undefined">{{ t.result.count }} 条结果</span>
                  <span v-if="t.result.score !== undefined"> · 评分 {{ t.result.score }}（{{ t.result.grade }}）</span>
                  <span v-if="t.result.enterprise_total !== undefined"> · 共 {{ t.result.enterprise_total }} 家企业，平均 {{ t.result.avg_score }} 分</span>
                  <ul v-if="t.result.enterprises" class="tool-items">
                    <li v-for="e in t.result.enterprises" :key="e.name">{{ e.name }} — {{ e.score }} 分（{{ e.grade }}）</li>
                  </ul>
                </template>
              </div>
            </div>

            <!-- 正文 -->
            <div v-if="m.text" class="bubble" v-html="render(m.text)"></div>
            <div v-else-if="m.streaming && !m.tools.length" class="bubble typing"><i></i><i></i><i></i></div>
            <div v-if="m.error" class="bubble error-bubble">{{ m.error }}</div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="composer">
        <textarea
          v-model="input"
          rows="2"
          placeholder="问点什么，例如：康美药业风险如何？（Enter 发送，Shift+Enter 换行）"
          @keydown.enter.exact.prevent="send()"
        ></textarea>
        <button v-if="busy" class="btn ghost" @click="stop">停止</button>
        <button v-else class="btn primary" :disabled="!input.trim()" @click="send()">发送</button>
      </div>
      <p class="hint">
        Agent 会按需调用：搜索企业 → 评分画像 → 风险事实 → （可选）触发完整研判。工具调用过程实时展示。
      </p>
    </div>
  </div>
</template>

<style scoped>
.chat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  height: calc(100vh - 250px);
  min-height: 480px;
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 空态 */
.welcome {
  margin: auto;
  text-align: center;
  max-width: 560px;
}

.welcome-mark {
  width: 52px;
  height: 52px;
  margin: 0 auto 12px;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.welcome h3 {
  margin: 0 0 6px;
  font-size: 17px;
}

.welcome p {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-sub);
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
  padding: 7px 14px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.suggest:hover {
  border-color: var(--primary);
  color: var(--primary);
  transform: translateY(-1px);
}

/* 消息 */
.msg {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.msg.user {
  justify-content: flex-end;
}

.avatar {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bubble-wrap {
  max-width: 78%;
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
  padding: 12px 15px;
  font-size: 13.5px;
  line-height: 1.75;
  word-break: break-word;
}

.bubble :deep(h3),
.bubble :deep(h4) {
  margin: 10px 0 6px;
  font-size: 14px;
}

.bubble :deep(ul) {
  margin: 6px 0;
  padding-left: 18px;
}

.bubble :deep(li) {
  margin: 3px 0;
}

.bubble :deep(code) {
  background: rgba(37, 99, 235, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}

.msg.user .bubble {
  background: linear-gradient(135deg, var(--primary), var(--primary-deep));
  color: #fff;
}

.error-bubble {
  background: rgba(220, 38, 38, 0.1);
  color: var(--danger);
  font-size: 12.5px;
}

/* 打字动画 */
.typing {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 14px 16px;
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

/* 工具卡片 */
.tool-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  background: var(--bg-elev);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}

.tool-card.running {
  border-left-color: var(--warn);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tool-name {
  font-weight: 600;
}

.tool-args {
  color: var(--text-sub);
  font-size: 11px;
  background: var(--hover);
  border-radius: 4px;
  padding: 1px 6px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-tag {
  font-size: 10.5px;
  color: var(--warn);
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 5px;
}

.tool-result {
  margin-top: 6px;
  color: var(--text-sub);
  font-size: 11.5px;
}

.tool-items {
  margin: 4px 0 0;
  padding-left: 16px;
}

/* 输入区 */
.composer {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.6;
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
}

.composer textarea:focus {
  border-color: var(--primary);
}

.hint {
  margin: 0;
  padding: 0 16px 12px;
  font-size: 11.5px;
  color: var(--text-sub);
}
</style>

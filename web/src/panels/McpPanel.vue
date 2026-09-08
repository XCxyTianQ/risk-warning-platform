<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { api } from '../api'

interface Server {
  id: number
  name: string
  url: string
  enabled: boolean
  require_approval: boolean
  status: string
  status_detail: string
  tool_count: number
  tools: { name: string; description: string }[]
  synced_at: string | null
}

const items = ref<Server[]>([])
const loading = ref(true)
const error = ref('')
const toast = ref('')
const expanded = ref<number | null>(null)

const addOpen = ref(false)
const form = ref({ name: '', url: '', auth_header: '', require_approval: false })
const adding = ref(false)

async function load() {
  loading.value = true
  try {
    items.value = (await api.mcpServers()).items
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function add() {
  adding.value = true
  error.value = ''
  try {
    const r = await api.addMcpServer(form.value)
    toast.value = `已添加 ${form.value.name}，同步到 ${r.tool_count ?? 0} 个工具`
    addOpen.value = false
    form.value = { name: '', url: '', auth_header: '', require_approval: false }
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    adding.value = false
  }
}

async function act(fn: () => Promise<any>, label: string) {
  try {
    const r = await fn()
    toast.value = r?.error ? `${label}失败：${r.error}` : `${label}成功`
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 5000)
}

async function toggle(s: Server, key: 'enabled' | 'require_approval') {
  await api.patchMcpServer(s.id, { [key]: !s[key] })
  await load()
}

async function remove(s: Server) {
  if (!confirm(`删除 MCP 服务「${s.name}」？`)) return
  await api.deleteMcpServer(s.id)
  await load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>MCP 服务</h2>
        <p class="page-sub">外部 MCP 工具接入（HTTP JSON-RPC），同步后 Agent 即可调用</p>
      </div>
      <div class="head-actions">
        <button class="btn primary small" @click="addOpen = true">＋ 添加服务</button>
        <button class="btn ghost small" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="toast" class="toast">{{ toast }}</p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="card">
      <div v-if="!items.length && !loading" class="empty">尚未接入 MCP 服务。可先启动 <code>tests/mock_mcp_server.py</code> 再添加 http://127.0.0.1:8765/mcp</div>
      <div v-for="s in items" :key="s.id" class="srv">
        <div class="srv-head" @click="expanded = expanded === s.id ? null : s.id">
          <span class="dot" :class="s.status === 'ok' ? 'ok' : s.status === 'error' ? 'fail' : ''"></span>
          <div class="srv-main">
            <div class="srv-name">
              {{ s.name }}
              <span class="badge">{{ s.tool_count }} 个工具</span>
              <span v-if="s.require_approval" class="badge warn">写操作需授权</span>
              <span v-if="!s.enabled" class="badge muted">已停用</span>
            </div>
            <div class="srv-url">{{ s.url }}</div>
            <div v-if="s.status_detail" class="srv-status">{{ s.status_detail }}</div>
          </div>
          <span class="chev">{{ expanded === s.id ? '▾' : '▸' }}</span>
        </div>

        <div v-if="expanded === s.id" class="srv-body">
          <ul class="tools">
            <li v-for="t in s.tools" :key="t.name">
              <code>{{ t.name }}</code>
              <span>{{ t.description }}</span>
            </li>
            <li v-if="!s.tools.length" class="empty">暂无工具（点击「同步」拉取）</li>
          </ul>
          <div class="srv-actions">
            <button class="btn ghost small" @click="act(() => api.testMcpServer(s.id), '连通测试')">测试连接</button>
            <button class="btn ghost small" @click="act(() => api.syncMcpServer(s.id), '同步工具')">同步工具</button>
            <button class="btn ghost small" @click="toggle(s, 'enabled')">{{ s.enabled ? '停用' : '启用' }}</button>
            <button class="btn ghost small" @click="toggle(s, 'require_approval')">
              {{ s.require_approval ? '取消授权要求' : '写操作需授权' }}
            </button>
            <button class="btn ghost small danger" @click="remove(s)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 添加服务 -->
    <div v-if="addOpen" class="mask" @click.self="addOpen = false">
      <div class="dialog">
        <h3>添加 MCP 服务</h3>
        <label class="field"><span>名称 *</span><input v-model="form.name" placeholder="如 mock-mcp" /></label>
        <label class="field"><span>MCP 地址 *</span><input v-model="form.url" placeholder="http://127.0.0.1:8765/mcp" /></label>
        <label class="field"><span>认证头（可选）</span><input v-model="form.auth_header" placeholder="Bearer xxx" /></label>
        <label class="field checkbox">
          <input v-model="form.require_approval" type="checkbox" />
          <span>该服务的工具视为写操作，调用前需用户授权</span>
        </label>
        <p v-if="error" class="error-box">{{ error }}</p>
        <div class="dlg-actions">
          <button class="btn ghost" @click="addOpen = false">取消</button>
          <button class="btn primary" :disabled="adding || !form.name || !form.url" @click="add">
            {{ adding ? '添加中…' : '添加并同步' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}

.srv {
  border-bottom: 1px solid var(--border-soft);
}

.srv:last-child {
  border-bottom: none;
}

.srv-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 6px;
  cursor: pointer;
}

.srv-head:hover {
  background: var(--hover);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
  margin-top: 6px;
  flex: none;
}

.dot.ok {
  background: var(--ok);
}

.dot.fail {
  background: var(--danger);
}

.srv-main {
  flex: 1;
  min-width: 0;
}

.srv-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.badge {
  font-size: 10.5px;
  font-weight: 400;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  color: var(--text-sub);
}

.badge.warn {
  color: var(--warn);
  border-color: rgba(217, 119, 6, 0.4);
}

.badge.muted {
  color: var(--text-sub);
  opacity: 0.7;
}

.srv-url,
.srv-status {
  font-size: 11px;
  color: var(--text-sub);
  font-family: Consolas, monospace;
}

.chev {
  color: var(--text-sub);
  font-size: 12px;
}

.srv-body {
  padding: 0 6px 12px 24px;
}

.tools {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.tools li {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--text-sub);
}

.tools code {
  color: var(--primary);
  font-size: 11.5px;
}

.srv-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.danger {
  color: var(--danger);
}

/* 弹窗 */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 60;
  display: flex;
  justify-content: center;
  padding-top: 10vh;
}

.dialog {
  width: min(480px, 92vw);
  height: fit-content;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  padding: 18px 20px;
}

.dialog h3 {
  margin: 0 0 14px;
  font-size: 15px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  margin-bottom: 12px;
}

.field input:not([type='checkbox']) {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
}

.field input:focus {
  border-color: var(--primary);
}

.field.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>

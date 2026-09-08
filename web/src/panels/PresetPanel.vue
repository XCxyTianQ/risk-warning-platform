<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { api } from '../api'

type Tab = 'presets' | 'tools' | 'skills'

interface Preset {
  id: number
  name: string
  description: string
  prompt_extra: string
  tools: string[]
  skills: string[]
  model_override: string
  enabled: boolean
  builtin: boolean
}

interface CustomTool {
  id: number
  name: string
  description: string
  parameters: Record<string, any>
  method: string
  url: string
  headers: Record<string, string>
  body_template: string
  enabled: boolean
  require_approval: boolean
  builtin: boolean
}

interface Skill {
  id: number
  name: string
  description: string
  content: string
  enabled: boolean
  builtin: boolean
}

const tab = ref<Tab>('presets')
const presets = ref<Preset[]>([])
const tools = ref<CustomTool[]>([])
const skills = ref<Skill[]>([])
const builtinToolNames = ref<string[]>([])
const error = ref('')
const toast = ref('')

// 编辑态
const editPreset = ref<Preset | null>(null)
const editTool = ref<CustomTool | null>(null)
const editSkill = ref<Skill | null>(null)
const saving = ref(false)

async function load() {
  try {
    const [p, t, s, agentTools] = await Promise.all([
      api.presets(),
      api.customTools(),
      api.skills(),
      api.settings(),
    ])
    presets.value = p.items
    tools.value = t.items
    skills.value = s.items
    // 内置工具名（来自 MCP 端点暴露列表）
    builtinToolNames.value = [
      'search_enterprise', 'get_score_profile', 'get_risk_facts', 'list_enterprises_by_level',
      'get_platform_overview', 'list_alerts', 'handle_alert', 'get_alert_report',
      'refresh_enterprise_data', 'resolve_stock_code', 'add_enterprise', 'run_risk_analysis',
      'list_skills', 'load_skill',
    ]
    void agentTools
  } catch (e) {
    error.value = (e as Error).message
  }
}

function newPreset() {
  editPreset.value = {
    id: 0, name: '', description: '', prompt_extra: '', tools: [], skills: [],
    model_override: '', enabled: true, builtin: false,
  }
}

function newTool() {
  editTool.value = {
    id: 0, name: '', description: '', method: 'GET', url: '',
    parameters: { type: 'object', properties: {} }, headers: {}, body_template: '',
    enabled: true, require_approval: false, builtin: false,
  }
}

function newSkill() {
  editSkill.value = { id: 0, name: '', description: '', content: '', enabled: true, builtin: false }
}

async function savePreset() {
  if (!editPreset.value) return
  saving.value = true
  error.value = ''
  try {
    const body = {
      name: editPreset.value.name,
      description: editPreset.value.description,
      prompt_extra: editPreset.value.prompt_extra,
      tools: editPreset.value.tools,
      skills: editPreset.value.skills,
      model_override: editPreset.value.model_override,
      enabled: editPreset.value.enabled,
    }
    if (editPreset.value.id) await api.updatePreset(editPreset.value.id, body)
    else await api.createPreset(body)
    editPreset.value = null
    toast.value = '预设已保存'
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
    setTimeout(() => (toast.value = ''), 4000)
  }
}

async function saveTool() {
  if (!editTool.value) return
  saving.value = true
  error.value = ''
  try {
    const body = {
      name: editTool.value.name,
      description: editTool.value.description,
      method: editTool.value.method,
      url: editTool.value.url,
      parameters: editTool.value.parameters,
      headers: editTool.value.headers,
      body_template: editTool.value.body_template,
      enabled: editTool.value.enabled,
      require_approval: editTool.value.require_approval,
    }
    if (editTool.value.id) await api.updateCustomTool(editTool.value.id, body)
    else await api.createCustomTool(body)
    editTool.value = null
    toast.value = '插件已保存'
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
    setTimeout(() => (toast.value = ''), 4000)
  }
}

async function testTool(t: CustomTool) {
  try {
    const r = await api.testCustomTool(t.id)
    toast.value = `调用成功：${JSON.stringify(r).slice(0, 120)}`
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 6000)
}

async function saveSkill() {
  if (!editSkill.value) return
  saving.value = true
  try {
    if (editSkill.value.id) await api.updateSkill(editSkill.value.id, editSkill.value)
    else await api.createSkill(editSkill.value)
    editSkill.value = null
    toast.value = '技能已保存'
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
    setTimeout(() => (toast.value = ''), 4000)
  }
}

function toggleToolField(list: string[], name: string) {
  const i = list.indexOf(name)
  if (i >= 0) list.splice(i, 1)
  else list.push(name)
}

// ---------- 导入 / 导出 ----------
const importOpen = ref(false)
const importText = ref('')
const importStrategy = ref('rename')
const importResult = ref<any>(null)
const importing = ref(false)

function download(name: string, data: any) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

async function exportPreset(p: Preset) {
  try {
    const bundle = await api.exportPreset(p.id)
    download(`preset-${p.name}.json`, bundle)
    toast.value = `已导出「${p.name}」`
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 4000)
}

async function exportAll() {
  try {
    const bundle = await api.exportAll()
    download(`agent-bundle-${new Date().toISOString().slice(0, 10)}.json`, bundle)
    toast.value = '已导出全部预设/技能/插件'
  } catch (e) {
    error.value = (e as Error).message
  }
  setTimeout(() => (toast.value = ''), 4000)
}

function pickFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => (importText.value = String(reader.result || ''))
  reader.readAsText(file)
}

async function doImport() {
  importing.value = true
  error.value = ''
  importResult.value = null
  try {
    const data = JSON.parse(importText.value)
    const r = await api.importBundle(data, importStrategy.value)
    importResult.value = r
    toast.value = `导入完成：预设 ${r.presets.length} · 技能 ${r.skills.length} · 插件 ${r.tools.length}`
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    importing.value = false
    setTimeout(() => (toast.value = ''), 6000)
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>Agent 预设</h2>
        <p class="page-sub">预设 = 提示词补充 + 工具白名单 + 技能白名单（对话时可切换）</p>
      </div>
      <div class="head-actions">
        <button class="btn ghost small" @click="exportAll">⤓ 导出全部</button>
        <button class="btn ghost small" @click="importOpen = true; importResult = null">⤒ 导入</button>
        <button v-if="tab === 'presets'" class="btn primary small" @click="newPreset">＋ 新建预设</button>
        <button v-else-if="tab === 'tools'" class="btn primary small" @click="newTool">＋ 手搓插件</button>
        <button v-else class="btn primary small" @click="newSkill">＋ 新建技能</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="chips">
        <button class="chip-btn" :class="{ active: tab === 'presets' }" @click="tab = 'presets'">
          🧩 预设 {{ presets.length }}
        </button>
        <button class="chip-btn" :class="{ active: tab === 'tools' }" @click="tab = 'tools'">
          🔧 插件 {{ tools.length }}
        </button>
        <button class="chip-btn" :class="{ active: tab === 'skills' }" @click="tab = 'skills'">
          📚 技能 {{ skills.length }}
        </button>
      </div>
    </div>

    <p v-if="toast" class="toast">{{ toast }}</p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <!-- 预设列表 -->
    <div v-if="tab === 'presets'" class="card">
      <div v-for="p in presets" :key="p.id" class="row">
        <div class="row-main">
          <div class="row-name">
            {{ p.name }}
            <span v-if="p.builtin" class="badge">内置</span>
            <span v-if="p.model_override" class="badge">{{ p.model_override }}</span>
            <span v-if="!p.enabled" class="badge muted">已停用</span>
          </div>
          <div class="row-desc">{{ p.description }}</div>
          <div class="row-meta">
            工具：{{ p.tools.length ? p.tools.join('、') : '全部' }}
            <template v-if="p.skills.length"> · 技能：{{ p.skills.join('、') }}</template>
          </div>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" @click="editPreset = { ...p }">编辑</button>
          <button class="btn ghost small" @click="exportPreset(p)">导出</button>
          <button class="btn ghost small" @click="api.updatePreset(p.id, { enabled: !p.enabled }).then(load)">
            {{ p.enabled ? '停用' : '启用' }}
          </button>
          <button v-if="!p.builtin" class="btn ghost small danger" @click="api.deletePreset(p.id).then(load)">删除</button>
        </div>
      </div>
    </div>

    <!-- 插件列表 -->
    <div v-else-if="tab === 'tools'" class="card">
      <div v-if="!tools.length" class="empty">还没有插件。点右上角「＋ 手搓插件」用声明式 HTTP 模板接入任意 REST 接口。</div>
      <div v-for="t in tools" :key="t.id" class="row">
        <div class="row-main">
          <div class="row-name">
            <code>custom_{{ t.name }}</code>
            <span class="badge">{{ t.method }}</span>
            <span v-if="t.require_approval" class="badge warn">写操作需授权</span>
            <span v-if="!t.enabled" class="badge muted">已停用</span>
          </div>
          <div class="row-desc">{{ t.description }}</div>
          <div class="row-meta url">{{ t.url }}</div>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" @click="testTool(t)">测试</button>
          <button class="btn ghost small" @click="editTool = { ...t }">编辑</button>
          <button class="btn ghost small" @click="api.updateCustomTool(t.id, { enabled: !t.enabled }).then(load)">
            {{ t.enabled ? '停用' : '启用' }}
          </button>
          <button class="btn ghost small danger" @click="api.deleteCustomTool(t.id).then(load)">删除</button>
        </div>
      </div>
    </div>

    <!-- 技能列表 -->
    <div v-else class="card">
      <div v-for="s in skills" :key="s.id" class="row">
        <div class="row-main">
          <div class="row-name">
            {{ s.name }}
            <span v-if="s.builtin" class="badge">内置</span>
            <span v-if="!s.enabled" class="badge muted">已停用</span>
          </div>
          <div class="row-desc">{{ s.description }}</div>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" @click="editSkill = { ...s }">编辑</button>
          <button class="btn ghost small" @click="api.updateSkill(s.id, { enabled: !s.enabled }).then(load)">
            {{ s.enabled ? '停用' : '启用' }}
          </button>
          <button v-if="!s.builtin" class="btn ghost small danger" @click="api.deleteSkill(s.id).then(load)">删除</button>
        </div>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <div v-if="importOpen" class="mask" @click.self="importOpen = false">
      <div class="dialog">
        <h3>导入预设 / 技能 / 插件</h3>
        <label class="field">
          <span>选择 JSON 文件</span>
          <input type="file" accept="application/json,.json" @change="pickFile" />
        </label>
        <label class="field">
          <span>或粘贴分享包内容</span>
          <textarea v-model="importText" rows="10" placeholder='{"kind":"risk-warning-agent-bundle", ...}'></textarea>
        </label>
        <label class="field">
          <span>同名冲突处理</span>
          <select v-model="importStrategy">
            <option value="rename">重命名导入（推荐）</option>
            <option value="skip">跳过同名</option>
            <option value="overwrite">覆盖同名</option>
          </select>
        </label>
        <div v-if="importResult" class="import-result">
          <div class="ir-row"><span>预设</span><b>{{ importResult.presets.join('、') || '—' }}</b></div>
          <div class="ir-row"><span>技能</span><b>{{ importResult.skills.join('、') || '—' }}</b></div>
          <div class="ir-row"><span>插件</span><b>{{ importResult.tools.join('、') || '—' }}</b></div>
          <div v-if="importResult.skipped.length" class="ir-row">
            <span>已跳过</span><b>{{ importResult.skipped.join('、') }}</b>
          </div>
        </div>
        <div class="dlg-actions">
          <button class="btn ghost" @click="importOpen = false">关闭</button>
          <button class="btn primary" :disabled="importing || !importText.trim()" @click="doImport">
            {{ importing ? '导入中…' : '导入' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 预设编辑 -->
    <div v-if="editPreset" class="mask" @click.self="editPreset = null">
      <div class="dialog">
        <h3>{{ editPreset.id ? '编辑预设' : '新建预设' }}</h3>
        <label class="field"><span>名称 *</span><input v-model="editPreset.name" /></label>
        <label class="field"><span>描述</span><input v-model="editPreset.description" /></label>
        <label class="field">
          <span>提示词补充</span>
          <textarea v-model="editPreset.prompt_extra" rows="4" placeholder="追加到 system 提示词的角色/风格约束"></textarea>
        </label>
        <label class="field"><span>模型覆盖（可选）</span><input v-model="editPreset.model_override" placeholder="留空使用全局模型" /></label>

        <div class="field-block">
          <div class="fb-title">工具白名单（不选 = 全部工具）</div>
          <div class="chips">
            <button
              v-for="n in builtinToolNames"
              :key="n"
              class="chip-btn"
              :class="{ active: editPreset.tools.includes(n) }"
              @click="toggleToolField(editPreset.tools, n)"
            >
              {{ n }}
            </button>
          </div>
        </div>

        <div class="field-block">
          <div class="fb-title">技能白名单（不选 = 全部技能）</div>
          <div class="chips">
            <button
              v-for="s in skills"
              :key="s.id"
              class="chip-btn"
              :class="{ active: editPreset.skills.includes(s.name) }"
              @click="toggleToolField(editPreset.skills, s.name)"
            >
              {{ s.name }}
            </button>
          </div>
        </div>

        <div class="dlg-actions">
          <button class="btn ghost" @click="editPreset = null">取消</button>
          <button class="btn primary" :disabled="saving || !editPreset.name" @click="savePreset">保存</button>
        </div>
      </div>
    </div>

    <!-- 插件编辑 -->
    <div v-if="editTool" class="mask" @click.self="editTool = null">
      <div class="dialog">
        <h3>{{ editTool.id ? '编辑插件' : '手搓插件' }}</h3>
        <label class="field"><span>工具名 *</span><input v-model="editTool.name" placeholder="如 weather_query（会注册为 custom_weather_query）" /></label>
        <label class="field"><span>描述</span><input v-model="editTool.description" placeholder="告诉 Agent 什么时候用它" /></label>
        <div class="two">
          <label class="field"><span>方法</span>
            <select v-model="editTool.method">
              <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option>
            </select>
          </label>
          <label class="field"><span>调用地址 *</span><input v-model="editTool.url" placeholder="https://api.example.com/x?q={keyword}" /></label>
        </div>
        <label class="field">
          <span>参数 JSON Schema</span>
          <textarea
            :value="JSON.stringify(editTool.parameters, null, 2)"
            rows="6"
            @input="editTool.parameters = JSON.parse(($event.target as HTMLTextAreaElement).value || '{}')"
          ></textarea>
        </label>
        <label class="field">
          <span>请求头（JSON）</span>
          <textarea
            :value="JSON.stringify(editTool.headers, null, 2)"
            rows="3"
            @input="editTool.headers = JSON.parse(($event.target as HTMLTextAreaElement).value || '{}')"
          ></textarea>
        </label>
        <label class="field">
          <span>请求体模板（POST/PUT，支持 {arg} 占位）</span>
          <textarea v-model="editTool.body_template" rows="3" placeholder='{"query": "{keyword}"}'></textarea>
        </label>
        <label class="field checkbox">
          <input v-model="editTool.require_approval" type="checkbox" />
          <span>写操作：调用前需用户授权</span>
        </label>
        <div class="dlg-actions">
          <button class="btn ghost" @click="editTool = null">取消</button>
          <button class="btn primary" :disabled="saving || !editTool.name || !editTool.url" @click="saveTool">保存</button>
        </div>
      </div>
    </div>

    <!-- 技能编辑 -->
    <div v-if="editSkill" class="mask" @click.self="editSkill = null">
      <div class="dialog">
        <h3>{{ editSkill.id ? '编辑技能' : '新建技能' }}</h3>
        <label class="field"><span>名称 *</span><input v-model="editSkill.name" /></label>
        <label class="field"><span>描述</span><input v-model="editSkill.description" /></label>
        <label class="field">
          <span>完整指令（Markdown）*</span>
          <textarea v-model="editSkill.content" rows="12"></textarea>
        </label>
        <div class="dlg-actions">
          <button class="btn ghost" @click="editSkill = null">取消</button>
          <button class="btn primary" :disabled="saving || !editSkill.name || !editSkill.content" @click="saveSkill">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 6px;
  border-bottom: 1px solid var(--border-soft);
}

.row:last-child {
  border-bottom: none;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.row-desc {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 3px;
}

.row-meta {
  font-size: 11px;
  color: var(--text-sub);
  margin-top: 3px;
}

.row-meta.url {
  font-family: Consolas, monospace;
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
  opacity: 0.7;
}

.row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex: none;
}

.head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.import-result {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--hover);
  padding: 10px 12px;
  margin-bottom: 12px;
}

.ir-row {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
  color: var(--text-sub);
  padding: 2px 0;
}

.ir-row b {
  color: var(--text);
  flex: 1;
  word-break: break-all;
}

.danger {
  color: var(--danger);
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 60;
  display: flex;
  justify-content: center;
  padding-top: 6vh;
}

.dialog {
  width: min(640px, 94vw);
  max-height: 88vh;
  overflow-y: auto;
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

.field input,
.field textarea,
.field select {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
  resize: vertical;
}

.field input:focus,
.field textarea:focus {
  border-color: var(--primary);
}

.field.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.two {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px;
}

.field-block {
  margin-bottom: 12px;
}

.fb-title {
  font-size: 12px;
  color: var(--text-sub);
  margin-bottom: 6px;
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>

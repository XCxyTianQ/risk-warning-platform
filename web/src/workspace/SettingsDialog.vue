<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { api } from '../api'

interface Field {
  key: string
  label: string
  type: string
  desc: string
  value: any
  has_value?: boolean
}

interface Group {
  group: string
  items: Field[]
}

interface Provider {
  id: string
  label: string
  base_url: string
  default_model: string
  key_hint: string
  note?: string
  key_optional?: boolean
}

const emit = defineEmits<{ close: []; saved: [] }>()

const groups = ref<Group[]>([])
const providers = ref<Provider[]>([])
const activeGroup = ref('模型服务')
const form = ref<Record<string, any>>({})
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const toast = ref('')

// 向导状态
const providerId = ref('')
const modelList = ref<string[]>([])
const fetchingModels = ref(false)
const modelError = ref('')
const showAdvanced = ref(false)

const current = computed(() => groups.value.find((g) => g.group === activeGroup.value) ?? groups.value[0])
const provider = computed(() => providers.value.find((p) => p.id === providerId.value) ?? null)
const basicFields = computed(() => (current.value?.items ?? []).filter((f) => ['llm_base_url', 'llm_api_key', 'llm_model'].includes(f.key)))
const advancedFields = computed(() =>
  (current.value?.items ?? []).filter((f) => !['llm_base_url', 'llm_api_key', 'llm_model'].includes(f.key)),
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.settings()
    groups.value = data.groups
    providers.value = data.providers ?? []
    form.value = {}
    for (const g of groups.value) for (const f of g.items) form.value[f.key] = f.value
    // 反推当前提供商
    const matched = providers.value.find((p) => p.base_url && p.base_url === data.runtime.base_url)
    providerId.value = matched?.id ?? 'custom'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function pickProvider(p: Provider) {
  providerId.value = p.id
  if (p.base_url) form.value.llm_base_url = p.base_url
  if (p.default_model && !form.value.llm_model) form.value.llm_model = p.default_model
  modelList.value = []
  modelError.value = ''
}

async function fetchModels() {
  fetchingModels.value = true
  modelError.value = ''
  try {
    const r = await api.listModels(form.value.llm_base_url, form.value.llm_api_key)
    modelList.value = r.models ?? []
    if (r.error) modelError.value = r.error
    else if (!modelList.value.length) modelError.value = '该端点未返回模型列表，可手动填写模型名称'
  } catch (e) {
    modelError.value = e instanceof Error ? e.message : String(e)
  } finally {
    fetchingModels.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const r = await api.updateSettings(form.value)
    groups.value = r.settings.groups
    providers.value = r.settings.providers ?? providers.value
    form.value = {}
    for (const g of groups.value) for (const f of g.items) form.value[f.key] = f.value
    toast.value = '设置已保存并立即生效（已重新预热缓存）'
    setTimeout(() => (toast.value = ''), 4000)
    emit('saved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function warmNow() {
  try {
    const r = await api.triggerPreheat()
    toast.value = r.skipped ? `未预热：${r.skipped}` : '已触发缓存预热'
    setTimeout(() => (toast.value = ''), 4000)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function reset() {
  if (!confirm('清除所有运行时覆盖值？重启后端后完全恢复 .env 默认配置。')) return
  await api.resetSettings()
  await load()
  toast.value = '已清除覆盖值'
}

onMounted(load)
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <aside class="side">
        <div class="side-title">设置</div>
        <button
          v-for="g in groups"
          :key="g.group"
          class="side-item"
          :class="{ active: activeGroup === g.group }"
          @click="activeGroup = g.group"
        >
          {{ g.group }}
        </button>
        <div class="side-foot">
          <button class="side-item" @click="warmNow">🔥 立即预热缓存</button>
          <button class="side-item danger" @click="reset">↺ 恢复默认</button>
        </div>
      </aside>

      <section class="main">
        <header class="main-head">
          <div class="mh-title">{{ current?.group }}</div>
          <button class="close" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div v-if="loading" class="empty">加载中…</div>

        <!-- 模型服务：向导式 -->
        <div v-else-if="activeGroup === '模型服务'" class="form">
          <div class="step">
            <div class="step-no">1</div>
            <div class="step-body">
              <div class="step-title">选择提供商</div>
              <div class="providers">
                <button
                  v-for="p in providers"
                  :key="p.id"
                  class="prov"
                  :class="{ active: providerId === p.id }"
                  @click="pickProvider(p)"
                >
                  <span class="prov-label">{{ p.label }}</span>
                  <span v-if="p.note" class="prov-note">{{ p.note }}</span>
                </button>
              </div>
            </div>
          </div>

          <div class="step">
            <div class="step-no">2</div>
            <div class="step-body">
              <div class="step-title">填写 API 地址与 Key</div>
              <div v-for="f in basicFields" :key="f.key" class="field">
                <label class="fl">
                  <span class="fl-label">{{ f.label }}</span>
                  <span class="fl-key">{{ f.key }}</span>
                </label>
                <div class="fc">
                  <template v-if="f.type === 'password'">
                    <input
                      v-model="form[f.key]"
                      type="password"
                      :placeholder="f.has_value ? `已配置（${provider?.key_hint ?? '留空则不修改'}）` : (provider?.key_hint ?? '请输入 API Key')"
                    />
                  </template>
                  <template v-else>
                    <input v-model="form[f.key]" type="text" :placeholder="f.desc" />
                  </template>
                  <div class="fd">{{ f.desc }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="step">
            <div class="step-no">3</div>
            <div class="step-body">
              <div class="step-title">
                获取可用模型
                <button class="btn ghost small" :disabled="fetchingModels || !form.llm_base_url" @click="fetchModels">
                  {{ fetchingModels ? '获取中…' : '⟳ 获取可用模型' }}
                </button>
              </div>
              <div v-if="modelError" class="error-box">{{ modelError }}</div>
              <div v-if="modelList.length" class="models">
                <button
                  v-for="m in modelList"
                  :key="m"
                  class="model-chip"
                  :class="{ active: form.llm_model === m }"
                  @click="form.llm_model = m"
                >
                  {{ m }}
                </button>
              </div>
              <div class="field" style="margin-top: 10px">
                <label class="fl"><span class="fl-label">当前模型</span><span class="fl-key">llm_model</span></label>
                <div class="fc">
                  <input v-model="form.llm_model" type="text" placeholder="从上方列表选择，或手动输入" />
                </div>
              </div>
            </div>
          </div>

          <div class="advanced">
            <button class="adv-toggle" @click="showAdvanced = !showAdvanced">
              {{ showAdvanced ? '▾' : '▸' }} 高级参数
            </button>
            <div v-if="showAdvanced" class="adv-body">
              <div v-for="f in advancedFields" :key="f.key" class="field">
                <label class="fl"><span class="fl-label">{{ f.label }}</span><span class="fl-key">{{ f.key }}</span></label>
                <div class="fc">
                  <input v-model.number="form[f.key]" type="number" />
                  <div class="fd">{{ f.desc }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 其他分组：普通表单 -->
        <div v-else class="form">
          <div v-for="f in current?.items ?? []" :key="f.key" class="field">
            <label class="fl"><span class="fl-label">{{ f.label }}</span><span class="fl-key">{{ f.key }}</span></label>
            <div class="fc">
              <template v-if="f.type === 'bool'">
                <label class="switch">
                  <input v-model="form[f.key]" type="checkbox" />
                  <span class="slider"></span>
                  <span class="switch-text">{{ form[f.key] ? '已启用' : '已关闭' }}</span>
                </label>
              </template>
              <template v-else-if="f.type === 'password'">
                <input v-model="form[f.key]" type="password" :placeholder="f.has_value ? '已配置（留空则不修改）' : '未配置'" />
              </template>
              <template v-else-if="f.type === 'int' || f.type === 'float'">
                <input v-model.number="form[f.key]" type="number" :step="f.type === 'float' ? 0.01 : 1" />
              </template>
              <template v-else>
                <input v-model="form[f.key]" type="text" />
              </template>
              <div class="fd">{{ f.desc }}</div>
            </div>
          </div>
        </div>

        <p v-if="error" class="error-box">{{ error }}</p>
        <p v-if="toast" class="toast">{{ toast }}</p>

        <footer class="main-foot">
          <span class="foot-hint">修改立即生效（写入本地数据库，重启后仍生效）</span>
          <div class="foot-actions">
            <button class="btn ghost" @click="emit('close')">取消</button>
            <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(3px);
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4vh 16px;
}

.dialog {
  display: flex;
  width: min(880px, 96vw);
  height: min(620px, 88vh);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.side {
  width: 190px;
  flex: none;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.side-title {
  font-size: 13px;
  font-weight: 700;
  padding: 4px 8px 10px;
}

.side-item {
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text-sub);
  font-family: inherit;
  font-size: 12.5px;
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}

.side-item:hover {
  background: var(--hover);
  color: var(--text);
}

.side-item.active {
  background: rgba(37, 99, 235, 0.1);
  color: var(--primary);
  font-weight: 600;
}

.side-item.danger:hover {
  color: var(--danger);
  background: rgba(220, 38, 38, 0.08);
}

.side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.main-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.mh-title {
  font-size: 14px;
  font-weight: 700;
}

.close {
  border: none;
  background: transparent;
  color: var(--text-sub);
  font-size: 14px;
  cursor: pointer;
  border-radius: 6px;
  width: 26px;
  height: 26px;
}

.close:hover {
  background: var(--hover);
  color: var(--danger);
}

.form {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 向导步骤 */
.step {
  display: flex;
  gap: 12px;
}

.step-no {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.step-body {
  flex: 1;
  min-width: 0;
}

.step-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 10px;
}

/* 提供商卡片 */
.providers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}

.prov {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 10px;
  padding: 9px 11px;
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
}

.prov:hover {
  border-color: var(--primary);
}

.prov.active {
  border-color: var(--primary);
  background: rgba(37, 99, 235, 0.08);
  font-weight: 600;
}

.prov-note {
  font-size: 10.5px;
  color: var(--text-sub);
  font-weight: 400;
}

/* 字段 */
.field {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 10px;
  align-items: start;
  margin-bottom: 10px;
}

.fl {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 6px;
}

.fl-label {
  font-size: 12.5px;
  font-weight: 600;
}

.fl-key {
  font-size: 10.5px;
  color: var(--text-sub);
  font-family: Consolas, monospace;
}

.fc input[type='text'],
.fc input[type='password'],
.fc input[type='number'] {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--bg-elev);
  color: var(--text);
  outline: none;
}

.fc input:focus {
  border-color: var(--primary);
}

.fd {
  font-size: 11px;
  color: var(--text-sub);
  margin-top: 4px;
}

/* 模型列表 */
.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.model-chip {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  font-family: Consolas, monospace;
  cursor: pointer;
}

.model-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.model-chip.active {
  border-color: var(--primary);
  background: rgba(37, 99, 235, 0.1);
  color: var(--primary);
  font-weight: 700;
}

/* 高级参数 */
.advanced {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.adv-toggle {
  border: none;
  background: transparent;
  color: var(--text-sub);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  padding: 2px 0;
}

.adv-toggle:hover {
  color: var(--primary);
}

.adv-body {
  margin-top: 10px;
}

/* 开关 */
.switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.switch input {
  display: none;
}

.slider {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--border);
  position: relative;
  transition: background 0.2s;
}

.slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}

.switch input:checked + .slider {
  background: var(--primary);
}

.switch input:checked + .slider::after {
  transform: translateX(16px);
}

.switch-text {
  font-size: 12px;
  color: var(--text-sub);
}

.main-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.foot-hint {
  font-size: 11px;
  color: var(--text-sub);
}

.foot-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 700px) {
  .dialog {
    flex-direction: column;
    height: 90vh;
  }
  .side {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .side-foot {
    margin-top: 0;
    border-top: none;
    flex-direction: row;
  }
  .field {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>

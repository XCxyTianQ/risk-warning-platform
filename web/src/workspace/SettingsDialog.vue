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

const emit = defineEmits<{ close: []; saved: [] }>()

const groups = ref<Group[]>([])
const activeGroup = ref('')
const form = ref<Record<string, any>>({})
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const toast = ref('')
const preheat = ref<any>(null)

const current = computed(() => groups.value.find((g) => g.group === activeGroup.value) ?? groups.value[0])

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.settings()
    groups.value = data.groups
    activeGroup.value = groups.value[0]?.group ?? ''
    form.value = {}
    for (const g of groups.value) for (const f of g.items) form.value[f.key] = f.value
    preheat.value = await api.preheatStatus().catch(() => null)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const r = await api.updateSettings(form.value)
    groups.value = r.settings.groups
    form.value = {}
    for (const g of groups.value) for (const f of g.items) form.value[f.key] = f.value
    toast.value = '设置已保存并立即生效'
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
    preheat.value = r
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
      <!-- 左：分组导航 -->
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

      <!-- 右：表单 -->
      <section class="main">
        <header class="main-head">
          <div class="mh-title">{{ current?.group }}</div>
          <button class="close" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div v-if="loading" class="empty">加载中…</div>
        <div v-else class="form">
          <div v-for="f in current?.items ?? []" :key="f.key" class="field" :class="{ inline: f.type === 'bool' }">
            <label class="fl">
              <span class="fl-label">{{ f.label }}</span>
              <span class="fl-key">{{ f.key }}</span>
            </label>
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

          <!-- 缓存预热状态 -->
          <div v-if="activeGroup === '缓存与成本' && preheat" class="preheat-box">
            <div class="pb-title">预热状态</div>
            <div class="pb-row"><span>预热次数</span><b>{{ preheat.warm_count }}</b></div>
            <div class="pb-row"><span>最近一次</span><b>{{ preheat.last_label || '—' }}（{{ preheat.last_warm_ago ?? '—' }}s 前）</b></div>
            <div class="pb-row"><span>预热时命中</span><b>{{ preheat.last_hit_tokens }} token</b></div>
            <div class="pb-row"><span>预热累计成本</span><b>¥{{ (preheat.warm_cost ?? 0).toFixed(6) }}</b></div>
            <div class="pb-row"><span>新鲜期</span><b>{{ preheat.ttl_seconds }}s</b></div>
            <div v-if="preheat.last_error" class="pb-row err"><span>最近错误</span><b>{{ preheat.last_error }}</b></div>
          </div>

          <p v-if="error" class="error-box">{{ error }}</p>
          <p v-if="toast" class="toast">{{ toast }}</p>
        </div>

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

/* 左侧导航 */
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

/* 右侧主体 */
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
  gap: 14px;
}

.field {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 12px;
  align-items: start;
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

/* 预热状态卡 */
.preheat-box {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--hover);
  padding: 12px 14px;
}

.pb-title {
  font-size: 12.5px;
  font-weight: 700;
  margin-bottom: 8px;
}

.pb-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  padding: 2px 0;
  color: var(--text-sub);
}

.pb-row b {
  color: var(--text);
}

.pb-row.err b {
  color: var(--danger);
}

/* 底部 */
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

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { api } from '../api'

interface Skill {
  id: number
  name: string
  description: string
  content: string
  enabled: boolean
  builtin: boolean
  updated_at: string
}

const items = ref<Skill[]>([])
const loading = ref(true)
const error = ref('')
const toast = ref('')

const editing = ref<Skill | null>(null)
const draft = ref({ name: '', description: '', content: '' })
const saving = ref(false)

async function load() {
  loading.value = true
  try {
    items.value = (await api.skills()).items
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function startNew() {
  editing.value = { id: 0 } as Skill
  draft.value = { name: '', description: '', content: '' }
}

function startEdit(s: Skill) {
  editing.value = s
  draft.value = { name: s.name, description: s.description, content: s.content }
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    if (editing.value?.id) {
      await api.updateSkill(editing.value.id, draft.value)
    } else {
      await api.createSkill(draft.value)
    }
    toast.value = '技能已保存'
    editing.value = null
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
    setTimeout(() => (toast.value = ''), 4000)
  }
}

async function toggle(s: Skill) {
  await api.updateSkill(s.id, { enabled: !s.enabled })
  await load()
}

async function remove(s: Skill) {
  if (!confirm(`删除技能「${s.name}」？`)) return
  try {
    await api.deleteSkill(s.id)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>技能库</h2>
        <p class="page-sub">可复用的任务方法论；Agent 通过 list_skills / load_skill 按需载入</p>
      </div>
      <button class="btn primary small" @click="startNew">＋ 新建技能</button>
    </div>

    <p v-if="toast" class="toast">{{ toast }}</p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="card">
      <div v-if="!items.length && !loading" class="empty">暂无技能</div>
      <div v-for="s in items" :key="s.id" class="skill">
        <div class="sk-main">
          <div class="sk-name">
            {{ s.name }}
            <span v-if="s.builtin" class="badge">内置</span>
            <span v-if="!s.enabled" class="badge muted">已停用</span>
          </div>
          <div class="sk-desc">{{ s.description }}</div>
        </div>
        <div class="sk-actions">
          <button class="btn ghost small" @click="startEdit(s)">编辑</button>
          <button class="btn ghost small" @click="toggle(s)">{{ s.enabled ? '停用' : '启用' }}</button>
          <button v-if="!s.builtin" class="btn ghost small danger" @click="remove(s)">删除</button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="editing" class="mask" @click.self="editing = null">
      <div class="dialog">
        <h3>{{ editing.id ? '编辑技能' : '新建技能' }}</h3>
        <label class="field"><span>技能名称 *</span><input v-model="draft.name" placeholder="如 企业风险评估报告" /></label>
        <label class="field"><span>一句话描述</span><input v-model="draft.description" placeholder="告诉 Agent 什么时候用它" /></label>
        <label class="field">
          <span>完整指令（Markdown）*</span>
          <textarea v-model="draft.content" rows="12" placeholder="写出可执行的步骤：调用哪些工具、输出结构、注意事项…"></textarea>
        </label>
        <p v-if="error" class="error-box">{{ error }}</p>
        <div class="dlg-actions">
          <button class="btn ghost" @click="editing = null">取消</button>
          <button class="btn primary" :disabled="saving || !draft.name || !draft.content" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 6px;
  border-bottom: 1px solid var(--border-soft);
}

.skill:last-child {
  border-bottom: none;
}

.sk-main {
  flex: 1;
  min-width: 0;
}

.sk-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.badge {
  font-size: 10.5px;
  font-weight: 400;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  color: var(--text-sub);
}

.badge.muted {
  opacity: 0.7;
}

.sk-desc {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 3px;
}

.sk-actions {
  display: flex;
  gap: 6px;
  flex: none;
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
  width: min(620px, 94vw);
  height: fit-content;
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
.field textarea {
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

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>

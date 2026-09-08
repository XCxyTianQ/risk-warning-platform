<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { api } from '../api'
import AlertsView from '../views/AlertsView.vue'
import AnalyzeView from '../views/AnalyzeView.vue'
import DashboardView from '../views/DashboardView.vue'
import EnterpriseDetailView from '../views/EnterpriseDetailView.vue'
import EnterprisesView from '../views/EnterprisesView.vue'
import ChatPanel from '../panels/ChatPanel.vue'
import PanelFrame from './PanelFrame.vue'
import { PANEL_META, openPanel, workspace, type PanelType } from './store'

const COMPONENTS: Record<PanelType, any> = {
  chat: ChatPanel,
  profile: EnterpriseDetailView,
  dashboard: DashboardView,
  enterprises: EnterprisesView,
  alerts: AlertsView,
  analyze: AnalyzeView,
}

const LAUNCHER: PanelType[] = ['chat', 'dashboard', 'enterprises', 'alerts', 'analyze']

// ---- 命令面板 ----
const paletteOpen = ref(false)
const paletteQuery = ref('')
const enterpriseHits = ref<{ id: number; name: string; industry: string }[]>([])

const commands = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase()
  const base = (Object.keys(PANEL_META) as PanelType[])
    .filter((t) => !q || PANEL_META[t].title.includes(q) || PANEL_META[t].desc.toLowerCase().includes(q))
    .map((t) => ({ kind: 'panel' as const, type: t, label: PANEL_META[t].title, desc: PANEL_META[t].desc }))
  const ents = enterpriseHits.value
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .map((e) => ({ kind: 'enterprise' as const, id: e.id, label: e.name, desc: e.industry }))
  return [...base, ...ents].slice(0, 12)
})

async function loadEnterprises() {
  try {
    const r = await api.enterprises()
    enterpriseHits.value = r.items
  } catch {
    enterpriseHits.value = []
  }
}

function runCommand(cmd: any) {
  if (cmd.kind === 'panel') openPanel(cmd.type)
  else openPanel('profile', { props: { enterpriseId: cmd.id }, title: cmd.label })
  paletteOpen.value = false
  paletteQuery.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
    if (paletteOpen.value) loadEnterprises()
  } else if (e.key === 'Escape') {
    paletteOpen.value = false
  }
}

function panelProps(p: { type: PanelType; props: Record<string, any> }) {
  if (p.type === 'profile') return { enterpriseId: p.props.enterpriseId }
  return {}
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (!workspace.panels.length) {
    openPanel('chat')
    openPanel('dashboard')
  }
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="workspace">
    <!-- 工具条 -->
    <div class="ws-bar">
      <div class="ws-launcher">
        <button
          v-for="t in LAUNCHER"
          :key="t"
          class="ws-btn"
          :title="PANEL_META[t].desc"
          @click="openPanel(t)"
        >
          <span class="ws-icon">{{ PANEL_META[t].icon }}</span>
          <span class="ws-label">{{ PANEL_META[t].title }}</span>
        </button>
      </div>
      <div class="ws-right">
        <button class="ws-cmd" @click="paletteOpen = true; loadEnterprises()">
          🔍 命令面板 <kbd>Ctrl K</kbd>
        </button>
        <span class="ws-count">{{ workspace.panels.length }} 个面板</span>
      </div>
    </div>

    <!-- 画布 -->
    <div v-if="workspace.panels.length" class="canvas">
      <PanelFrame v-for="(p, i) in workspace.panels" :key="p.id" :panel="p" :index="i">
        <component :is="COMPONENTS[p.type]" v-bind="panelProps(p)" />
      </PanelFrame>
    </div>

    <!-- 空画布引导 -->
    <div v-else class="empty-canvas">
      <h2>工作台</h2>
      <p>从下面的入口打开面板，面板之间可以并排对比、拖拽排序、随时关闭。</p>
      <div class="empty-cards">
        <button v-for="t in LAUNCHER" :key="t" class="empty-card" @click="openPanel(t)">
          <span class="ec-icon">{{ PANEL_META[t].icon }}</span>
          <span class="ec-title">{{ PANEL_META[t].title }}</span>
          <span class="ec-desc">{{ PANEL_META[t].desc }}</span>
        </button>
      </div>
    </div>

    <!-- 命令面板 -->
    <div v-if="paletteOpen" class="palette-mask" @click.self="paletteOpen = false">
      <div class="palette">
        <input
          v-model="paletteQuery"
          class="palette-input"
          placeholder="搜索面板或企业…（Esc 关闭）"
          autofocus
        />
        <ul class="palette-list">
          <li v-for="(c, i) in commands" :key="i" @click="runCommand(c)">
            <span class="pl-kind">{{ c.kind === 'panel' ? '面板' : '企业' }}</span>
            <span class="pl-label">{{ c.label }}</span>
            <span class="pl-desc">{{ c.desc }}</span>
          </li>
          <li v-if="!commands.length" class="pl-empty">没有匹配项</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 工具条 */
.ws-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ws-launcher {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ws-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  border-radius: 10px;
  padding: 7px 13px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: all 0.15s;
}

.ws-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
  transform: translateY(-1px);
}

.ws-icon {
  font-size: 14px;
}

.ws-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ws-cmd {
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-sub);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.ws-cmd:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.ws-cmd kbd {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 10.5px;
  margin-left: 4px;
}

.ws-count {
  font-size: 11.5px;
  color: var(--text-sub);
}

/* 画布 */
.canvas {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 12px;
  align-items: start;
}

/* 空态 */
.empty-canvas {
  text-align: center;
  padding: 60px 20px;
}

.empty-canvas h2 {
  margin: 0 0 6px;
}

.empty-canvas p {
  color: var(--text-sub);
  font-size: 13px;
  margin: 0 0 24px;
}

.empty-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  max-width: 860px;
  margin: 0 auto;
}

.empty-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: 12px;
  padding: 20px 14px;
  cursor: pointer;
  box-shadow: var(--shadow);
  font-family: inherit;
  color: var(--text);
  transition: all 0.15s;
}

.empty-card:hover {
  border-color: var(--primary);
  transform: translateY(-2px);
}

.ec-icon {
  font-size: 22px;
}

.ec-title {
  font-weight: 700;
  font-size: 13.5px;
}

.ec-desc {
  font-size: 11.5px;
  color: var(--text-sub);
  text-align: center;
}

/* 命令面板 */
.palette-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 50;
  display: flex;
  justify-content: center;
  padding-top: 12vh;
}

.palette {
  width: min(560px, 92vw);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.palette-input {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 14px 16px;
  font-size: 14px;
  font-family: inherit;
  background: transparent;
  color: var(--text);
  outline: none;
}

.palette-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.palette-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.palette-list li:hover {
  background: var(--hover);
}

.pl-kind {
  font-size: 10.5px;
  color: var(--primary);
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 5px;
  flex: none;
}

.pl-label {
  font-weight: 600;
  flex: none;
}

.pl-desc {
  font-size: 11.5px;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-empty {
  color: var(--text-sub);
  font-size: 12.5px;
  justify-content: center;
}
</style>

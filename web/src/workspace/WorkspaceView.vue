<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { api } from '../api'
import ChatPanel from '../panels/ChatPanel.vue'
import DockZone from './DockZone.vue'
import { COMPONENTS, panelProps } from './registry'
import {
  drag,
  dropOn,
  openPanel,
  PANEL_META,
  panelsOf,
  resetLayout,
  setDragOver,
  setSize,
  workspace,
  type DockZone as Zone,
  type PanelType,
} from './store'

const LAUNCHER: PanelType[] = ['dashboard', 'enterprises', 'alerts', 'analyze', 'profile', 'finance', 'presets', 'mcp']

const leftPanels = computed(() => panelsOf('left'))
const rightPanels = computed(() => panelsOf('right'))
const bottomPanels = computed(() => panelsOf('bottom'))
const maximizedPanel = computed(() => workspace.panels.find((p) => p.id === workspace.maximized) ?? null)

const stageStyle = computed(() => ({
  '--left-w': `${workspace.sizes.left}px`,
  '--right-w': `${workspace.sizes.right}px`,
  '--bottom-h': `${workspace.sizes.bottom}px`,
}))

// ---------- 拖动分屏 ----------
function startResize(zone: Zone, e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const base = workspace.sizes[zone]

  const move = (ev: PointerEvent) => {
    if (zone === 'left') setSize('left', base + (ev.clientX - startX))
    else if (zone === 'right') setSize('right', base - (ev.clientX - startX))
    else setSize('bottom', base - (ev.clientY - startY))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }
  document.body.style.userSelect = 'none'
  document.body.style.cursor = zone === 'bottom' ? 'row-resize' : 'col-resize'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ---------- 命令面板 ----------
const paletteOpen = ref(false)
const paletteQuery = ref('')
const enterpriseHits = ref<{ id: number; name: string; industry: string }[]>([])

const commands = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase()
  const panels = (Object.keys(PANEL_META) as PanelType[])
    .filter((t) => !q || PANEL_META[t].title.includes(q) || PANEL_META[t].desc.toLowerCase().includes(q))
    .map((t) => ({ kind: 'panel' as const, type: t, label: PANEL_META[t].title, desc: PANEL_META[t].desc }))
  const ents = enterpriseHits.value
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .map((e) => ({ kind: 'enterprise' as const, id: e.id, label: e.name, desc: e.industry }))
  return [...panels, ...ents].slice(0, 12)
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

onMounted(() => {
  // 每次启动只显示对话区：清空上次的面板布局
  resetLayout()
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="ide">
    <!-- 左侧功能栏 -->
    <aside class="rail">
      <button
        v-for="t in LAUNCHER"
        :key="t"
        class="rail-btn"
        :title="`${PANEL_META[t].title} — ${PANEL_META[t].desc}`"
        @click="openPanel(t)"
      >
        <span>{{ PANEL_META[t].icon }}</span>
      </button>
      <div class="rail-sep"></div>
      <button class="rail-btn" title="命令面板 (Ctrl+K)" @click="paletteOpen = true; loadEnterprises()">⌘</button>
    </aside>

    <!-- 停靠舞台 -->
    <div class="stage" :style="stageStyle">
      <div class="stage-top">
        <DockZone v-if="leftPanels.length" zone="left" class="area area-left" />
        <div v-if="leftPanels.length" class="split split-v" @pointerdown="startResize('left', $event)"></div>

        <!-- 主区：LLM 对话工作区 -->
        <section class="area-main">
          <ChatPanel />
        </section>

        <div v-if="rightPanels.length" class="split split-v" @pointerdown="startResize('right', $event)"></div>
        <DockZone v-if="rightPanels.length" zone="right" class="area area-right" />
      </div>

      <div v-if="bottomPanels.length" class="split split-h" @pointerdown="startResize('bottom', $event)"></div>
      <DockZone v-if="bottomPanels.length" zone="bottom" class="area area-bottom" />

      <!-- 拖拽停靠落点（拖动标签时出现） -->
      <template v-if="drag.panelId">
        <div
          class="drop-zone dz-left"
          :class="{ over: drag.overZone === 'left' }"
          @dragover.prevent="setDragOver('left')"
          @dragleave="setDragOver('')"
          @drop.prevent="dropOn('left')"
        >
          停靠到左侧
        </div>
        <div
          class="drop-zone dz-right"
          :class="{ over: drag.overZone === 'right' }"
          @dragover.prevent="setDragOver('right')"
          @dragleave="setDragOver('')"
          @drop.prevent="dropOn('right')"
        >
          停靠到右侧
        </div>
        <div
          class="drop-zone dz-bottom"
          :class="{ over: drag.overZone === 'bottom' }"
          @dragover.prevent="setDragOver('bottom')"
          @dragleave="setDragOver('')"
          @drop.prevent="dropOn('bottom')"
        >
          停靠到底部
        </div>
      </template>
    </div>

    <!-- 最大化面板 -->
    <div v-if="maximizedPanel" class="max-overlay">
      <header class="max-head">
        <span>{{ PANEL_META[maximizedPanel.type].icon }} {{ maximizedPanel.title }}</span>
        <button class="btn ghost small" @click="workspace.maximized = null">还原 ✕</button>
      </header>
      <div class="max-body">
        <component
          :is="COMPONENTS[maximizedPanel.type]"
          v-bind="panelProps(maximizedPanel)"
          :key="maximizedPanel.id"
        />
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
.ide {
  display: flex;
  gap: 10px;
  height: calc(100vh - 152px);
  min-height: 520px;
}

/* ---------- 左侧功能栏 ---------- */
.rail {
  width: 52px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
}

.rail-btn {
  width: 36px;
  height: 36px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 9px;
  font-size: 17px;
  cursor: pointer;
  color: var(--text);
  transition: all 0.15s;
}

.rail-btn:hover {
  background: var(--hover);
  border-color: var(--primary);
}

.rail-sep {
  width: 24px;
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

/* ---------- 舞台 ---------- */
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  position: relative;
}

.stage-top {
  display: flex;
  flex: 1;
  min-height: 0;
}

.area {
  min-width: 0;
  min-height: 0;
}

.area-left {
  width: var(--left-w);
  flex: none;
}

.area-right {
  width: var(--right-w);
  flex: none;
}

.area-bottom {
  height: var(--bottom-h);
  flex: none;
}

.area-main {
  flex: 1;
  min-width: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 分屏拖拽条 */
.split-v {
  width: 8px;
  flex: none;
  cursor: col-resize;
  position: relative;
}

.split-h {
  height: 8px;
  flex: none;
  cursor: row-resize;
  position: relative;
}

.split-v::after,
.split-h::after {
  content: '';
  position: absolute;
  background: transparent;
  transition: background 0.15s;
}

.split-v::after {
  top: 12%;
  bottom: 12%;
  left: 3px;
  width: 2px;
  border-radius: 2px;
}

.split-h::after {
  left: 12%;
  right: 12%;
  top: 3px;
  height: 2px;
  border-radius: 2px;
}

.split-v:hover::after,
.split-h:hover::after {
  background: var(--primary);
}

/* ---------- 拖拽停靠落点 ---------- */
.drop-zone {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
  background: rgba(37, 99, 235, 0.08);
  border: 2px dashed rgba(37, 99, 235, 0.45);
  border-radius: 10px;
  z-index: 30;
  pointer-events: auto;
  transition: background 0.15s, border-color 0.15s;
}

.drop-zone.over {
  background: rgba(37, 99, 235, 0.2);
  border-color: var(--primary);
}

.dz-left {
  left: 0;
  top: 0;
  bottom: 0;
  width: 22%;
}

.dz-right {
  right: 0;
  top: 0;
  bottom: 0;
  width: 22%;
}

.dz-bottom {
  left: 0;
  right: 0;
  bottom: 0;
  height: 26%;
}

/* ---------- 最大化 ---------- */
.max-overlay {
  position: fixed;
  inset: 68px 16px 16px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  z-index: 40;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.max-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: 13px;
  font-weight: 700;
}

.max-body {
  flex: 1;
  overflow: auto;
  padding: 16px 18px;
}

/* ---------- 命令面板 ---------- */
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
  height: fit-content;
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

@media (max-width: 900px) {
  .area-left,
  .area-right {
    display: none;
  }
}
</style>

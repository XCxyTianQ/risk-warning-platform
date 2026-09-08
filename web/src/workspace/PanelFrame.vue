<script setup lang="ts">
import { ref } from 'vue'

import { closePanel, focusPanel, movePanel, toggleSpan, workspace, type Panel } from './store'

const props = defineProps<{ panel: Panel; index: number }>()

const dragging = ref(false)
const dragOver = ref(false)

function onDragStart(e: DragEvent) {
  dragging.value = true
  e.dataTransfer?.setData('text/plain', String(props.index))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  dragging.value = false
  const from = Number(e.dataTransfer?.getData('text/plain'))
  if (!Number.isNaN(from)) movePanel(from, props.index)
}
</script>

<template>
  <section
    class="panel"
    :class="{ focused: workspace.focused === panel.id, dragging }"
    :style="{ gridColumn: `span ${panel.span}` }"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
    @mousedown="focusPanel(panel.id)"
  >
    <header
      class="panel-head"
      draggable="true"
      @dragstart="onDragStart"
      @dragend="dragging = false"
    >
      <span class="panel-title">
        <span class="grip" title="拖拽调整顺序">⠿</span>
        {{ panel.title }}
      </span>
      <span class="panel-actions">
        <button class="pa" :title="panel.span === 2 ? '收窄' : '加宽'" @click.stop="toggleSpan(panel.id)">
          {{ panel.span === 2 ? '⇥' : '⇤' }}
        </button>
        <button class="pa" title="关闭" @click.stop="closePanel(panel.id)">✕</button>
      </span>
    </header>
    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.panel.focused {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.25), var(--shadow);
}

.panel.dragging {
  opacity: 0.5;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  cursor: grab;
  user-select: none;
}

.panel-title {
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grip {
  color: var(--text-sub);
  font-size: 12px;
}

.panel-actions {
  display: flex;
  gap: 4px;
}

.pa {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-sub);
  border-radius: 6px;
  width: 22px;
  height: 22px;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.pa:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.panel-body {
  padding: 12px 14px;
  overflow: auto;
  max-height: calc(100vh - 210px);
}

/* 面板内嵌页面时收敛标题与内边距 */
.panel-body :deep(.page) {
  gap: 12px;
}

.panel-body :deep(.page-head h2),
.panel-body :deep(.page-head .page-sub),
.panel-body :deep(.page-head > div > button.btn.ghost.small) {
  display: none;
}

.panel-body :deep(.page-head) {
  min-height: 0;
  justify-content: flex-end;
}

.panel-body :deep(.card) {
  box-shadow: none;
  border: 1px solid var(--border-soft);
}
</style>

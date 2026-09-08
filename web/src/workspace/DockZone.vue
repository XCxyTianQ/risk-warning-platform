<script setup lang="ts">
import { computed } from 'vue'

import { COMPONENTS, panelProps } from './registry'
import {
  activate,
  activePanelOf,
  closePanel,
  drag,
  dropOn,
  endPanelDrag,
  PANEL_META,
  panelsOf,
  setDock,
  setDragOver,
  startPanelDrag,
  toggleMaximize,
  type DockZone,
} from './store'

const props = defineProps<{ zone: DockZone }>()

const list = computed(() => panelsOf(props.zone))
const active = computed(() => activePanelOf(props.zone))
const horizontal = computed(() => props.zone === 'bottom')

const DOCK_ICON: Record<DockZone, string> = { left: '⇤', right: '⇥', bottom: '⇩' }
const DOCK_TITLE: Record<DockZone, string> = { left: '停靠左侧', right: '停靠右侧', bottom: '停靠底部' }

function onTabDragStart(id: string, e: DragEvent) {
  startPanelDrag(id)
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
  }
}
</script>

<template>
  <section
    class="zone"
    :class="[`zone-${zone}`, { 'drop-target': drag.panelId && drag.overZone === zone }]"
    @dragover.prevent="setDragOver(zone)"
    @dragleave="setDragOver('')"
    @drop.prevent="dropOn(zone)"
  >
    <!-- 标签栏 -->
    <div class="tabs">
      <button
        v-for="p in list"
        :key="p.id"
        class="tab"
        :class="{ active: active?.id === p.id }"
        draggable="true"
        @dragstart="onTabDragStart(p.id, $event)"
        @dragend="endPanelDrag"
        @click="activate(p.id)"
      >
        <span class="tab-icon">{{ PANEL_META[p.type].icon }}</span>
        <span class="tab-label">{{ p.title }}</span>
        <span class="tab-actions">
          <i
            v-for="z in (['left', 'right', 'bottom'] as DockZone[]).filter((x) => x !== zone)"
            :key="z"
            :title="DOCK_TITLE[z]"
            @click.stop="setDock(p.id, z)"
          >{{ DOCK_ICON[z] }}</i>
          <i title="最大化" @click.stop="toggleMaximize(p.id)">⛶</i>
          <i title="关闭" @click.stop="closePanel(p.id)">✕</i>
        </span>
      </button>
      <span class="tabs-hint">{{ list.length }} 个标签</span>
    </div>

    <!-- 内容 -->
    <div class="zone-body" :class="{ horizontal }">
      <component :is="COMPONENTS[active.type]" v-if="active" v-bind="panelProps(active)" :key="active.id" />
    </div>
  </section>
</template>

<style scoped>
.zone {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.zone.drop-target {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25), var(--shadow);
}

/* 标签栏 */
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  overflow-x: auto;
  flex: none;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-sub);
  border-radius: 8px;
  padding: 5px 9px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.tab:hover {
  background: var(--hover);
  color: var(--text);
}

.tab.active {
  background: var(--card);
  border-color: var(--border);
  color: var(--text);
  font-weight: 600;
}

.tab-icon {
  font-size: 13px;
}

.tab-actions {
  display: none;
  gap: 3px;
  margin-left: 2px;
}

.tab.active .tab-actions,
.tab:hover .tab-actions {
  display: inline-flex;
}

.tab-actions i {
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-sub);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 15px;
}

.tab-actions i:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.tabs-hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-sub);
  white-space: nowrap;
}

/* 内容区 */
.zone-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
}

.zone-body :deep(.page) {
  gap: 12px;
}

/* 停靠区内收敛页面标题（标签栏已显示标题） */
.zone-body :deep(.page-head h2),
.zone-body :deep(.page-head .page-sub),
.zone-body :deep(.page-head > div > button.btn.ghost.small) {
  display: none;
}

.zone-body :deep(.page-head) {
  min-height: 0;
  justify-content: flex-end;
}

.zone-body :deep(.card) {
  box-shadow: none;
  border: 1px solid var(--border-soft);
}

.zone-bottom .zone-body :deep(.detail-grid),
.zone-bottom .zone-body :deep(.dim-grid),
.zone-bottom .zone-body :deep(.chart-grid) {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
</style>

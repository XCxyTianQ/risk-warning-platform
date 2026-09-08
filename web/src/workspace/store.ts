/** IDE 式停靠工作区状态：对话为主区，其他面板停靠左/右/底部 */

import { reactive, watch } from 'vue'

export type PanelType = 'profile' | 'dashboard' | 'enterprises' | 'alerts' | 'analyze'
export type DockZone = 'left' | 'right' | 'bottom'

export interface Panel {
  id: string
  type: PanelType
  title: string
  props: Record<string, any>
  dock: DockZone
  singleton: boolean
}

export const PANEL_META: Record<PanelType, { title: string; icon: string; desc: string; singleton: boolean }> = {
  profile: { title: '企业评分画像', icon: '🎯', desc: '六维评分雷达 + 评级解读', singleton: false },
  dashboard: { title: '风险总览', icon: '📊', desc: '平台统计与风险分布', singleton: true },
  enterprises: { title: '企业档案', icon: '🏢', desc: '企业列表与筛选', singleton: true },
  alerts: { title: '风险线索', icon: '🚨', desc: '大模型产出的风险事实', singleton: true },
  analyze: { title: '智能研判', icon: '🧠', desc: '单企业一键研判', singleton: true },
}

interface WorkspaceState {
  panels: Panel[]
  active: Record<DockZone, string>
  sizes: Record<DockZone, number>
  maximized: string | null
}

const STORAGE_KEY = 'rw-workspace-v2'

let seq = 0
const nextId = () => `p${Date.now().toString(36)}${++seq}`

export const workspace = reactive<WorkspaceState>({
  panels: [],
  active: { left: '', right: '', bottom: '' },
  sizes: { left: 380, right: 440, bottom: 300 },
  maximized: null,
})

export function panelsOf(zone: DockZone): Panel[] {
  return workspace.panels.filter((p) => p.dock === zone)
}

export function activePanelOf(zone: DockZone): Panel | null {
  const list = panelsOf(zone)
  if (!list.length) return null
  return list.find((p) => p.id === workspace.active[zone]) ?? list[0]
}

export function openPanel(
  type: PanelType,
  opts: { props?: Record<string, any>; title?: string; dock?: DockZone } = {},
): Panel {
  const meta = PANEL_META[type]
  const props = opts.props ?? {}
  const dock = opts.dock ?? 'right'

  if (meta.singleton) {
    const existing = workspace.panels.find((p) => p.type === type)
    if (existing) {
      Object.assign(existing.props, props)
      if (opts.title) existing.title = opts.title
      existing.dock = dock
      workspace.active[dock] = existing.id
      workspace.maximized = null
      return existing
    }
  }

  if (type === 'profile' && props.enterpriseId) {
    const dup = workspace.panels.find(
      (p) => p.type === 'profile' && p.props.enterpriseId === props.enterpriseId,
    )
    if (dup) {
      dup.dock = dock
      workspace.active[dock] = dup.id
      workspace.maximized = null
      return dup
    }
  }

  const panel: Panel = {
    id: nextId(),
    type,
    title: opts.title ?? meta.title,
    props,
    dock,
    singleton: meta.singleton,
  }
  workspace.panels.push(panel)
  workspace.active[dock] = panel.id
  workspace.maximized = null
  return panel
}

export function closePanel(id: string) {
  const i = workspace.panels.findIndex((p) => p.id === id)
  if (i < 0) return
  const [removed] = workspace.panels.splice(i, 1)
  if (workspace.maximized === id) workspace.maximized = null
  const list = panelsOf(removed.dock)
  workspace.active[removed.dock] = list.length ? list[list.length - 1].id : ''
}

export function setDock(id: string, zone: DockZone) {
  const p = workspace.panels.find((x) => x.id === id)
  if (!p || p.dock === zone) return
  p.dock = zone
  workspace.active[zone] = id
  const list = panelsOf(p.dock)
  if (!list.length) workspace.active[p.dock] = ''
}

export function activate(id: string) {
  const p = workspace.panels.find((x) => x.id === id)
  if (p) {
    workspace.active[p.dock] = id
    workspace.maximized = null
  }
}

export function toggleMaximize(id: string) {
  workspace.maximized = workspace.maximized === id ? null : id
}

export function setSize(zone: DockZone, px: number) {
  const min = zone === 'bottom' ? 140 : 260
  const max = zone === 'bottom' ? 640 : 760
  workspace.sizes[zone] = Math.max(min, Math.min(max, Math.round(px)))
}

/** 对话工具结果 → 自动停靠开窗（Agent 与界面协作） */
export function openForTool(name: string, result: Record<string, any>) {
  if (!result || result.ok === false) return
  if (name === 'get_score_profile' || name === 'run_risk_analysis' || name === 'get_risk_facts') {
    const id = result.enterprise_id ?? result.enterprise?.id
    if (id) {
      openPanel('profile', {
        props: { enterpriseId: id },
        title: result.enterprise_name ?? result.enterprise ?? '企业评分画像',
        dock: 'right',
      })
    }
    return
  }
  if (name === 'search_enterprise' || name === 'list_enterprises_by_level') {
    openPanel('enterprises', { dock: 'right' })
    return
  }
  if (name === 'get_platform_overview') {
    openPanel('dashboard', { dock: 'bottom' })
    return
  }
  if (name === 'list_alerts' || name === 'handle_alert' || name === 'get_alert_report') {
    openPanel('alerts', { dock: 'right' })
  }
}

/** 拖拽停靠状态（HTML5 DnD） */
export const drag = reactive({
  panelId: '' as string,
  overZone: '' as DockZone | '',
})

export function startPanelDrag(id: string) {
  drag.panelId = id
}

export function setDragOver(zone: DockZone | '') {
  drag.overZone = zone
}

export function endPanelDrag() {
  drag.panelId = ''
  drag.overZone = ''
}

export function dropOn(zone: DockZone) {
  if (drag.panelId) setDock(drag.panelId, zone)
  endPanelDrag()
}

// ---------- 布局持久化 ----------
function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        panels: workspace.panels,
        active: workspace.active,
        sizes: workspace.sizes,
      }),
    )
  } catch {
    /* 忽略配额/隐私模式错误 */
  }
}

export function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw)
    if (Array.isArray(data.panels)) workspace.panels = data.panels
    if (data.active) Object.assign(workspace.active, data.active)
    if (data.sizes) Object.assign(workspace.sizes, data.sizes)
  } catch {
    /* 损坏则忽略 */
  }
}

watch(workspace, persist, { deep: true })

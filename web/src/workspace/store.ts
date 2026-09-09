/** IDE 式停靠工作区状态：对话为主区，其他面板停靠左/右/底部 */

import { reactive } from 'vue'

export type PanelType = 'profile' | 'dashboard' | 'enterprises' | 'alerts' | 'analyze' | 'finance' | 'mcp' | 'presets'
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
  finance: { title: '金融分析', icon: '📈', desc: '杜邦分解 + Z/F/M 模型 + 同业对标', singleton: true },
  mcp: { title: 'MCP 服务', icon: '🔌', desc: '外部 MCP 工具接入与同步', singleton: true },
  presets: { title: 'Agent 预设', icon: '🧩', desc: '预设组合 + 手搓插件/技能', singleton: true },
}

interface WorkspaceState {
  panels: Panel[]
  active: Record<DockZone, string>
  sizes: Record<DockZone, number>
  maximized: string | null
}

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
  if (name === 'get_financial_analysis' || name === 'compare_financials' || name === 'screen_by_financial_metric') {
    const id = result.enterprise_id ?? result.enterprise?.id ?? result.rows?.[0]?.enterprise_id
    openPanel('finance', {
      props: id ? { enterpriseId: id } : {},
      title: result.enterprise?.name ?? '金融分析',
      dock: 'right',
    })
    return
  }
  if (name === 'get_platform_overview') {
    openPanel('dashboard', { dock: 'bottom' })
    return
  }
  if (name === 'list_alerts' || name === 'handle_alert' || name === 'get_alert_report') {
    openPanel('alerts', { dock: 'right' })
    return
  }
  if (name === 'list_skills' || name === 'load_skill') {
    openPanel('presets', { dock: 'right' })
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

// ---------- 启动状态 ----------
/** 每次启动只显示对话区（主区），不恢复上次的面板布局 */
export function resetLayout() {
  workspace.panels = []
  workspace.active = { left: '', right: '', bottom: '' }
  workspace.maximized = null
}

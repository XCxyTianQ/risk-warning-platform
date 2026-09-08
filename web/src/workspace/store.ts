/** 工作台面板状态：多面板并存、对话驱动开窗、可拖拽排序 */

import { reactive } from 'vue'

export type PanelType = 'chat' | 'profile' | 'dashboard' | 'enterprises' | 'alerts' | 'analyze'

export interface Panel {
  id: string
  type: PanelType
  title: string
  props: Record<string, any>
  span: 1 | 2
  singleton: boolean
}

export const PANEL_META: Record<PanelType, { title: string; icon: string; span: 1 | 2; singleton: boolean; desc: string }> = {
  chat: { title: '智能问答', icon: '💬', span: 1, singleton: true, desc: '自然语言提问，Agent 自动调用工具' },
  profile: { title: '企业评分画像', icon: '🎯', span: 1, singleton: false, desc: '六维评分雷达 + 评级解读' },
  dashboard: { title: '风险总览', icon: '📊', span: 2, singleton: true, desc: '平台统计与风险分布' },
  enterprises: { title: '企业档案', icon: '🏢', span: 1, singleton: true, desc: '企业列表与筛选' },
  alerts: { title: '风险线索', icon: '🚨', span: 1, singleton: true, desc: '大模型产出的风险事实' },
  analyze: { title: '智能研判', icon: '🧠', span: 1, singleton: true, desc: '单企业一键研判' },
}

let seq = 0
const nextId = () => `p${++seq}`

export const workspace = reactive({
  panels: [] as Panel[],
  focused: '',
})

export function openPanel(type: PanelType, opts: { props?: Record<string, any>; title?: string } = {}): Panel {
  const meta = PANEL_META[type]
  const props = opts.props ?? {}

  // 单例面板：已存在则复用（更新 props）
  if (meta.singleton) {
    const existing = workspace.panels.find((p) => p.type === type)
    if (existing) {
      Object.assign(existing.props, props)
      if (opts.title) existing.title = opts.title
      workspace.focused = existing.id
      return existing
    }
  }

  // 画像面板：同一企业不重复开
  if (type === 'profile' && props.enterpriseId) {
    const dup = workspace.panels.find((p) => p.type === 'profile' && p.props.enterpriseId === props.enterpriseId)
    if (dup) {
      workspace.focused = dup.id
      return dup
    }
  }

  const panel: Panel = {
    id: nextId(),
    type,
    title: opts.title ?? meta.title,
    props,
    span: meta.span,
    singleton: meta.singleton,
  }
  workspace.panels.push(panel)
  workspace.focused = panel.id
  return panel
}

export function closePanel(id: string) {
  const i = workspace.panels.findIndex((p) => p.id === id)
  if (i >= 0) workspace.panels.splice(i, 1)
  if (workspace.focused === id) workspace.focused = workspace.panels[workspace.panels.length - 1]?.id ?? ''
}

export function toggleSpan(id: string) {
  const p = workspace.panels.find((x) => x.id === id)
  if (p) p.span = p.span === 2 ? 1 : 2
}

export function focusPanel(id: string) {
  workspace.focused = id
}

export function movePanel(from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= workspace.panels.length || to >= workspace.panels.length) return
  const [item] = workspace.panels.splice(from, 1)
  workspace.panels.splice(to, 0, item)
}

/** 对话工具结果 → 自动在画布开窗（Agent 与界面协作的核心） */
export function openForTool(name: string, result: Record<string, any>) {
  if (!result || result.ok === false) return
  if (name === 'get_score_profile' || name === 'run_risk_analysis') {
    const id = result.enterprise_id ?? result.enterprise?.id
    if (id) openPanel('profile', { props: { enterpriseId: id }, title: result.enterprise_name ?? result.enterprise ?? '企业评分画像' })
    return
  }
  if (name === 'get_risk_facts') {
    if (result.enterprise_id) {
      openPanel('profile', { props: { enterpriseId: result.enterprise_id }, title: result.enterprise_name ?? '企业评分画像' })
    }
    return
  }
  if (name === 'search_enterprise' || name === 'list_enterprises_by_level') {
    openPanel('enterprises')
    return
  }
  if (name === 'get_platform_overview') {
    openPanel('dashboard')
  }
}

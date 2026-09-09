/** 面板类型 → 组件映射（DockZone 与最大化视图共用） */

import AlertsView from '../views/AlertsView.vue'
import AnalyzeView from '../views/AnalyzeView.vue'
import DashboardView from '../views/DashboardView.vue'
import EnterpriseDetailView from '../views/EnterpriseDetailView.vue'
import EnterprisesView from '../views/EnterprisesView.vue'
import FinanceView from '../views/FinanceView.vue'
import McpPanel from '../panels/McpPanel.vue'
import PresetPanel from '../panels/PresetPanel.vue'
import type { Panel, PanelType } from './store'

export const COMPONENTS: Record<PanelType, any> = {
  profile: EnterpriseDetailView,
  dashboard: DashboardView,
  enterprises: EnterprisesView,
  alerts: AlertsView,
  analyze: AnalyzeView,
  finance: FinanceView,
  mcp: McpPanel,
  presets: PresetPanel,
}

export function panelProps(p: Panel | null): Record<string, any> {
  if (!p) return {}
  if (p.type === 'profile' || p.type === 'finance') return { enterpriseId: p.props.enterpriseId }
  return {}
}

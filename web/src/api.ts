/** API 客户端：统一类型与错误处理 */

export interface EnterpriseRow {
  id: number
  name: string
  industry: string
  level: string
  dimensions: Record<string, string>
  indicators: Record<string, any>
}

export interface DashboardSummary {
  enterprise_total: number
  level_counts: Record<string, number>
  dimension_levels: Record<string, Record<string, number>>
  enterprises: EnterpriseRow[]
  fact_total: number
  recent_facts: { enterprise: string; dimension: string; text: string; ts: string }[]
  news_sentiment: Record<string, number>
}

export interface RiskFact {
  id: number
  enterprise_id: number
  enterprise: string
  dimension: string
  dimension_label: string
  text: string
  confidence: number
  ts: string
}

export interface RiskSnapshot {
  enterprise: { id: number; name: string }
  verdict_level: string
  dimensions: Record<string, { level: string; indicators?: Record<string, any> }>
  facts: { dimension: string; text: string; evidence: Record<string, any>; confidence: number; ts: string }[]
}

export interface AnalyzeResp {
  enterprise: { id: number; name: string; legal_rep: string; industry: string; data_note?: string }
  verdict: {
    level: string
    level_by: string
    cross_check_ok: boolean
    llm_level: string
    rules_level: string
    dimensions: Record<string, { level: string; indicators?: Record<string, any> }>
    summary: string
    evidence: { dimension: string; text: string; source?: string; date?: string }[]
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error((data as any).detail || `HTTP ${resp.status}`)
  return data as T
}

export const api = {
  summary: () => request<DashboardSummary>('/api/dashboard/summary'),
  enterprises: () => request<{ total: number; items: { id: number; name: string; industry: string; reg_date: string }[] }>('/api/enterprises'),
  enterprise: (id: number) => request<any>(`/api/enterprise/${id}`),
  risk: (id: number) => request<RiskSnapshot>(`/api/enterprise/${id}/risk`),
  facts: (params: { dimension?: string; enterprise_id?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.dimension) q.set('dimension', params.dimension)
    if (params.enterprise_id) q.set('enterprise_id', String(params.enterprise_id))
    return request<{ total: number; items: RiskFact[] }>(`/api/risk-facts?${q.toString()}`)
  },
  analyze: (name: string) =>
    request<AnalyzeResp>('/api/enterprises/analyze_by_name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
}

/** 等级元数据（颜色/标签/雷达数值） */
export const LEVELS: Record<string, { label: string; color: string; radar: number }> = {
  red: { label: '高风险', color: '#dc2626', radar: 100 },
  orange: { label: '较高风险', color: '#ea580c', radar: 75 },
  yellow: { label: '关注', color: '#ca8a04', radar: 50 },
  green: { label: '正常', color: '#16a34a', radar: 25 },
  gray: { label: '数据不足', color: '#94a3b8', radar: 0 },
}

export const DIM_LABEL: Record<string, string> = {
  finance: '财务',
  legal: '法律',
  news: '舆情',
}

export function levelOf(level?: string) {
  return LEVELS[level ?? 'gray'] ?? LEVELS.gray
}

export function fmtTime(ts: string) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'
}

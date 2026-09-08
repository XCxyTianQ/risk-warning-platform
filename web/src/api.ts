/** API 客户端：统一类型与错误处理 */

export interface EnterpriseRow {
  id: number
  name: string
  industry: string
  level: string
  score: number | null
  grade: string
  grade_label: string
  dimensions: Record<string, string>
  dimension_scores: Record<string, number | null>
  indicators: Record<string, any>
}

export interface DashboardSummary {
  enterprise_total: number
  avg_score: number | null
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

export interface DimensionView {
  score: number | null
  level: string
  label?: string
  note?: string
  indicators?: Record<string, any>
}

export interface RiskSnapshot {
  enterprise: { id: number; name: string }
  verdict_level: string
  score: number | null
  grade: string
  grade_label: string
  dimensions: Record<string, DimensionView>
  facts: { dimension: string; text: string; evidence: Record<string, any>; confidence: number; ts: string }[]
}

export interface AnalyzeResp {
  enterprise: { id: number; name: string; legal_rep: string; industry: string; data_note?: string }
  verdict: {
    level: string
    score: number | null
    grade: string
    grade_label: string
    level_by: string
    cross_check_ok: boolean
    llm_level: string
    rules_level: string
    dimensions: Record<string, DimensionView>
    summary: string
    evidence: { dimension: string; text: string; source?: string; date?: string }[]
  }
}

export interface AlertRow {
  id: number
  enterprise_id: number
  enterprise: string
  level: string
  dimension: string
  dimension_label: string
  title: string
  summary: string
  score: number | null
  status: string
  status_label: string
  handler: string
  created_at: string
  updated_at: string
  handled_at: string | null
  notes: { ts: string; status_label?: string; handler?: string; note?: string }[]
  evidence: any[]
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error((data as any).detail || `HTTP ${resp.status}`)
  return data as T
}

export const api = {
  summary: () => request<DashboardSummary>('/api/dashboard/summary'),
  enterprises: () =>
    request<{ total: number; items: { id: number; name: string; industry: string; reg_date: string }[] }>(
      '/api/enterprises',
    ),
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

  // --- 数据源 ---
  refreshEnterprise: (id: number, dimensions?: string) => {
    const q = dimensions ? `?dimensions=${dimensions}` : ''
    return request<{
      enterprise: { id: number; name: string; stock_code?: string }
      dimensions: Record<string, { ok: boolean; source?: string; fetched?: number; inserted?: number; updated?: number; gap?: string; error?: string }>
    }>(`/api/enterprise/${id}/refresh${q}`, { method: 'POST' })
  },
  datasources: () =>
    request<{ sources: { dimension: string; mode: string; sources: { name: string; dimensions: string[] }[] }[] }>(
      '/api/datasources',
    ),

  // --- 自由添加企业 ---
  resolveStock: (name: string) =>
    request<{ query: string; candidates: { code: string; name: string }[] }>(
      `/api/resolve_stock?name=${encodeURIComponent(name)}`,
    ),
  createEnterprise: (body: { name: string; stock_code?: string; auto_fetch?: boolean }) =>
    request<{
      enterprise_id: number
      name: string
      stock_code?: string
      resolved_from?: string
      refresh?: any
      error?: string
    }>('/api/enterprises', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteEnterprise: (id: number) =>
    request<{ deleted: number; name: string }>(`/api/enterprise/${id}`, { method: 'DELETE' }),

  // --- 预警中心 ---
  alerts: (params: { status?: string; level?: string; enterprise_id?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.level) q.set('level', params.level)
    if (params.enterprise_id) q.set('enterprise_id', String(params.enterprise_id))
    return request<{ total: number; items: AlertRow[] }>(`/api/alerts?${q.toString()}`)
  },
  alertSummary: () =>
    request<{ total: number; pending: number; handling: number; by_status: Record<string, number>; by_level: Record<string, number> }>(
      '/api/alerts/summary',
    ),
  generateAlerts: (enterprise_id?: number) =>
    request<{ created?: any[]; skipped?: number; enterprises?: number; error?: string }>('/api/alerts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enterprise_id: enterprise_id ?? null }),
    }),
  handleAlert: (id: number, action: string, handler = '', note = '') =>
    request<{ alert_id: number; status: string; status_label: string; notes: any[] }>(`/api/alerts/${id}/handle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, handler, note }),
    }),
  alertReportUrl: (id: number) => `/api/alerts/${id}/report`,

  // --- 对话会话（历史持久化） ---
  chatSessions: () =>
    request<{ sessions: { id: string; title: string; updated_at: string; message_count: number }[] }>(
      '/api/chat/sessions',
    ),
  chatSession: (id: string) =>
    request<{
      session_id: string
      title: string
      updated_at: string
      messages: { role: string; content: string; tool_calls: any[]; tool_call_id: string; tool_name: string }[]
    }>(`/api/chat/sessions/${id}`),
  chatDelete: (id: string) =>
    request<{ deleted: string }>(`/api/chat/sessions/${id}`, { method: 'DELETE' }),

  /** 全局/会话用量与成本（常驻状态栏） */
  chatUsage: (sessionId?: string) =>
    request<{
      model: string
      context_window: number
      threshold_ratio: number
      retain_ratio: number
      global: Record<string, number>
      session: (Record<string, number> & { session_id: string; title: string }) | null
    }>(`/api/chat/usage${sessionId ? `?session_id=${sessionId}` : ''}`),

  /** 动作工具审批 */
  chatApprove: (approvalId: string, approved: boolean) =>
    request<{ approval_id: string; approved: boolean }>('/api/chat/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_id: approvalId, approved }),
    }),
}

/** 风险等级元数据 */
export const LEVELS: Record<string, { label: string; color: string; radar: number }> = {
  red: { label: '高风险', color: '#dc2626', radar: 100 },
  orange: { label: '较高风险', color: '#ea580c', radar: 75 },
  yellow: { label: '关注', color: '#ca8a04', radar: 50 },
  green: { label: '正常', color: '#16a34a', radar: 25 },
  gray: { label: '数据不足', color: '#94a3b8', radar: 0 },
}

/** 六个评分维度 */
export const DIM_LABEL: Record<string, string> = {
  finance: '财务健康',
  legal: '法律合规',
  news: '舆情声誉',
  operation: '经营能力',
  credit: '信用状况',
  supply: '供应链稳定',
}

/** 综合评分 → 等级颜色 */
export function gradeColor(grade?: string): string {
  switch (grade) {
    case 'AAA':
    case 'AA':
      return '#16a34a'
    case 'A':
      return '#65a30d'
    case 'BBB':
      return '#ca8a04'
    case 'BB':
      return '#ea580c'
    case 'C':
      return '#dc2626'
    default:
      return '#94a3b8'
  }
}

/** 分数 → 颜色（越高越健康） */
export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return '#94a3b8'
  if (score >= 85) return '#16a34a'
  if (score >= 70) return '#ca8a04'
  if (score >= 55) return '#ea580c'
  return '#dc2626'
}

export function levelOf(level?: string) {
  return LEVELS[level ?? 'gray'] ?? LEVELS.gray
}

export function fmtTime(ts: string) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'
}

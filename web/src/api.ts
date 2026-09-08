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

  // --- 设置 ---
  settings: () =>
    request<{
      groups: { group: string; items: { key: string; label: string; type: string; desc: string; value: any; has_value?: boolean }[] }[]
      providers: {
        id: string
        label: string
        base_url: string
        default_model: string
        key_hint: string
        note?: string
        key_optional?: boolean
      }[]
      runtime: Record<string, any>
    }>('/api/settings'),
  listModels: (base_url: string, api_key?: string) =>
    request<{ models: string[]; count?: number; error?: string }>('/api/settings/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url, api_key }),
    }),
  updateSettings: (values: Record<string, any>) =>
    request<{ ok: boolean; applied: Record<string, any>; settings: any }>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  triggerPreheat: () =>
    request<{ ok?: boolean; skipped?: string; label?: string; warm_count?: number }>('/api/settings/preheat', { method: 'POST' }),
  preheatStatus: () => request<Record<string, any>>('/api/settings/preheat'),
  resetSettings: () => request<{ reset: boolean; note: string }>('/api/settings/reset', { method: 'POST' }),

  // --- MCP 服务 ---
  mcpServers: () =>
    request<{
      total: number
      items: {
        id: number
        name: string
        url: string
        enabled: boolean
        require_approval: boolean
        status: string
        status_detail: string
        tool_count: number
        tools: { name: string; description: string }[]
        synced_at: string | null
      }[]
    }>('/api/mcp/servers'),
  addMcpServer: (body: { name: string; url: string; auth_header?: string; require_approval?: boolean }) =>
    request<{ server_id: number; tool_count?: number; tools?: string[]; error?: string }>('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patchMcpServer: (id: number, body: Record<string, any>) =>
    request<{ ok: boolean }>(`/api/mcp/servers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteMcpServer: (id: number) => request<{ deleted: number }>(`/api/mcp/servers/${id}`, { method: 'DELETE' }),
  testMcpServer: (id: number) => request<{ ok: boolean; tools?: string[]; error?: string }>(`/api/mcp/servers/${id}/test`, { method: 'POST' }),
  syncMcpServer: (id: number) => request<{ ok: boolean; tool_count?: number; error?: string }>(`/api/mcp/servers/${id}/sync`, { method: 'POST' }),

  // --- 技能库 ---
  skills: () =>
    request<{
      total: number
      items: { id: number; name: string; description: string; content: string; enabled: boolean; builtin: boolean; updated_at: string }[]
    }>('/api/skills'),
  createSkill: (body: { name: string; description: string; content: string }) =>
    request<{ skill_id: number; name: string }>('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateSkill: (id: number, body: Record<string, any>) =>
    request<{ ok: boolean }>(`/api/skills/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteSkill: (id: number) => request<{ deleted: number }>(`/api/skills/${id}`, { method: 'DELETE' }),

  // --- Agent 预设 / 插件 / 技能 ---
  presets: () =>
    request<{
      total: number
      items: {
        id: number
        name: string
        description: string
        prompt_extra: string
        tools: string[]
        skills: string[]
        model_override: string
        enabled: boolean
        builtin: boolean
      }[]
    }>('/api/plugins/presets'),
  createPreset: (body: Record<string, any>) =>
    request<{ preset_id: number; name: string }>('/api/plugins/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updatePreset: (id: number, body: Record<string, any>) =>
    request<{ ok: boolean }>(`/api/plugins/presets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deletePreset: (id: number) => request<{ deleted: number }>(`/api/plugins/presets/${id}`, { method: 'DELETE' }),

  customTools: () =>
    request<{
      total: number
      items: {
        id: number
        name: string
        description: string
        parameters: Record<string, any>
        method: string
        url: string
        headers: Record<string, string>
        body_template: string
        enabled: boolean
        require_approval: boolean
        builtin: boolean
      }[]
    }>('/api/plugins/tools'),
  createCustomTool: (body: Record<string, any>) =>
    request<{ tool_id: number; name: string }>('/api/plugins/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateCustomTool: (id: number, body: Record<string, any>) =>
    request<{ ok: boolean }>(`/api/plugins/tools/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteCustomTool: (id: number) => request<{ deleted: number }>(`/api/plugins/tools/${id}`, { method: 'DELETE' }),
  testCustomTool: (id: number, args: Record<string, any> = {}) =>
    request<Record<string, any>>(`/api/plugins/tools/${id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }),

  exportPreset: (id: number) => request<Record<string, any>>(`/api/plugins/presets/${id}/export`),
  exportAll: () => request<Record<string, any>>('/api/plugins/export'),
  importBundle: (data: Record<string, any>, strategy: string) =>
    request<{ tools: string[]; skills: string[]; presets: string[]; skipped: string[]; strategy: string }>(
      '/api/plugins/import',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, strategy }),
      },
    ),

  // --- 对话会话（历史持久化 + 对话管理） ---
  chatSessions: (q = '') =>
    request<{
      sessions: {
        id: string
        title: string
        pinned: boolean
        updated_at: string
        created_at: string
        message_count: number
        cache_hit_rate: number
        shared: boolean
      }[]
    }>(`/api/chat/sessions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  chatPatch: (id: string, body: { title?: string; pinned?: boolean }) =>
    request<{ ok: boolean }>(`/api/chat/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  chatClear: (id: string) => request<{ deleted_messages: number }>(`/api/chat/sessions/${id}/clear`, { method: 'POST' }),
  chatBatchDelete: (ids: string[]) =>
    request<{ deleted: number }>('/api/chat/sessions/batch_delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  chatExportUrl: (id: string, format: 'md' | 'json') => `/api/chat/sessions/${id}/export?format=${format}`,
  chatShare: (id: string) =>
    request<{ token: string; url: string; created_at: string }>(`/api/chat/sessions/${id}/share`, { method: 'POST' }),
  chatRevokeShare: (id: string) => request<{ ok: boolean }>(`/api/chat/sessions/${id}/share`, { method: 'DELETE' }),
  chatImport: (data: Record<string, any>) =>
    request<{ session_id: string; title: string; messages: number }>('/api/chat/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }),
  shared: (token: string) =>
    request<{
      session_id: string
      title: string
      created_at: string
      updated_at: string
      usage: Record<string, number>
      messages: { role: string; content: string; tool_calls: any[]; tool_name: string }[]
    }>(`/api/share/${token}`),
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

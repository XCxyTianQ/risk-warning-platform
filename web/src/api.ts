/** API 客户端：统一类型与错误处理 */

export interface EnterpriseRow {
  id: number
  name: string
  stock_code?: string
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

// ---------- 金融分析模块 ----------

export interface FinanceKpi {
  key: string
  label: string
  unit: string
  group: string
  value: number | null
  prev: number | null
  yoy: number | null
  trend: 'up' | 'down' | 'flat'
  higher_better: boolean
  available: boolean
  year: string | null
  note: string
}

export interface FinanceSeries {
  key: string
  label: string
  unit: string
  points: { year: string; value: number | null }[]
}

export interface FinanceTrendGroup {
  label: string
  series: FinanceSeries[]
}

export interface DupontRow {
  year: string
  roe: number | null
  net_margin: number | null
  asset_turnover: number | null
  equity_multiplier: number | null
  complete: boolean
}

export interface AltmanModel {
  score: number | null
  verdict: string | null
  available: boolean
  basis: string
  thresholds: string
  components: Record<string, { value: number | null; source: string; label: string }>
  missing: string[]
  note: string
}

export interface FinanceAnalysis {
  enterprise: { id: number; name: string; industry: string; stock_code: string; legal_rep?: string; reg_date?: string; data_note?: string }
  available: boolean
  reason?: string
  latest_year?: string
  data_status?: string
  market_cap_wan?: number | null
  kpi: FinanceKpi[]
  trends: Record<string, FinanceTrendGroup>
  dupont: {
    formula: string
    rows: DupontRow[]
    attribution: {
      from_year: string
      to_year: string
      roe_delta: number
      items: { key: string; label: string; contrib: number }[]
      note: string
    } | null
  }
  models: {
    altman: { key: string; name: string; period: string; z: AltmanModel; z2: AltmanModel }
    piotroski: {
      key: string; name: string; period?: string; available: boolean; reason?: string
      score: number | null; max_score: number; full_score: number; verdict: string | null
      complete?: boolean
      signals: { name: string; group: string; pass: boolean | null; detail: string }[]
      note?: string
    }
    beneish: {
      key: string; name: string; period?: string; available: boolean; reason?: string
      score: number | null; thresholds?: string; verdict: string | null
      indices: { key: string; label: string; value: number | null; source: string; detail: string }[]
      missing: string[]; approx?: string[]; note?: string
    }
  }
  peers: {
    industry: string
    rows: {
      enterprise_id: number; name: string; industry: string; is_self: boolean; year: string
      metrics: Record<string, number | null>
      percentiles?: Record<string, number | null>
    }[]
    metrics: { key: string; label: string; unit: string; higher_better: boolean }[]
    note: string
  } | null
  peer_median?: Record<string, number>
  anomalies: { code: string; level: string; title: string; detail: string; evidence: Record<string, any> }[]
  data_quality: {
    years: number
    periods: { year: string; report_type: string; source: string; derived: string[] }[]
    missing_metrics: string[]
    notes: string[]
  }
}

export interface FinanceOverviewRow {
  enterprise_id: number
  name: string
  industry: string
  stock_code: string
  has_finance: boolean
  years: number
  latest_year: string | null
  revenue: number | null
  net_profit: number | null
  revenue_growth: number | null
  gross_margin: number | null
  net_margin: number | null
  roe: number | null
  debt_ratio: number | null
}

// --- 表格对象 ---
export interface TableColumn {
  key: string
  label: string
  period: string
  report_type: string
  type?: string
}

export interface TableCell {
  value: number
  raw?: any
  source?: string
  confidence?: number
}

export interface TableSheetRow {
  key: string
  label: string
  field?: string
  cells: Record<string, TableCell>
}

export interface TableDoc {
  id: number
  enterprise_id: number | null
  title: string
  kind: string
  unit: string
  scope: string
  period_type: string
  currency: string
  sheet: { columns: TableColumn[]; rows: TableSheetRow[]; meta?: Record<string, any> }
  mapping: Record<string, string>
  status: 'draft' | 'confirmed' | 'ingested'
  version: number
  origin: string
  note: string
  created_at: string
  updated_at: string
}

export interface TableRow {
  id: number
  enterprise_id: number | null
  enterprise: string | null
  title: string
  kind: string
  unit: string
  scope: string
  period_type: string
  status: string
  version: number
  origin: string
  updated_at: string
  columns: number
  rows: number
}

export interface TableIssue {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
  row: string
  col: string
}

export interface TableValidation {
  ok: boolean
  errors: number
  warnings: number
  issues: TableIssue[]
}

export interface AlertRow {  id: number
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

  // --- 金融分析模块 ---
  financeOverview: () =>
    request<{ total: number; items: FinanceOverviewRow[] }>('/api/finance/overview'),
  financeAnalysis: (id: number, years = 5, peers = true) =>
    request<FinanceAnalysis>(`/api/finance/${id}/analysis?years=${years}&peers=${peers}`),
  financeReportUrl: (id: number, years = 5) => `/api/finance/${id}/report?years=${years}`,

  // --- 表格对象（在线创建 / 编辑 / 校验 / 入库） ---
  tables: (params: { enterprise_id?: number; status?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.enterprise_id) q.set('enterprise_id', String(params.enterprise_id))
    if (params.status) q.set('status', params.status)
    return request<{ total: number; items: TableRow[] }>(`/api/tables?${q.toString()}`)
  },
  tableTemplates: () =>
    request<{
      templates: { kind: string; title: string; rows: { field: string; label: string }[] }[]
      fields: { key: string; label: string; kind: string; unit: string; aliases: string[] }[]
    }>('/api/tables/templates'),
  createTable: (body: {
    enterprise_id?: number | null
    title?: string
    kind?: string
    periods?: (string | string[])[]
    unit?: string
    scope?: string
    period_type?: string
    origin?: string
  }) =>
    request<{ table_id: number; title: string; kind: string; table: TableDoc }>('/api/tables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  table: (id: number) => request<TableDoc>(`/api/tables/${id}`),
  updateTable: (id: number, body: Record<string, any>) =>
    request<{ ok: boolean; version: number }>(`/api/tables/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteTable: (id: number) =>
    request<{ deleted: number }>(`/api/tables/${id}`, { method: 'DELETE' }),
  writeTableCells: (
    id: number,
    body: {
      row?: string
      col?: string
      value?: any
      cells?: Record<string, any>
      values?: any[][]
      source?: string
      confidence?: number
    },
  ) =>
    request<{ ok: boolean; written: number; version: number }>(`/api/tables/${id}/cells`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  validateTable: (id: number) =>
    request<TableValidation>(`/api/tables/${id}/validate`, { method: 'POST' }),
  previewIngest: (id: number) =>
    request<{
      table_id: number
      enterprise_id: number
      unit: string
      plan: { period: string; report_type: string; action: string; existing_source: string | null }[]
      validation: TableValidation
    }>(`/api/tables/${id}/preview`),
  ingestTable: (id: number, overwrite = false) =>
    request<{
      ok: boolean
      created: any[]
      updated: any[]
      skipped: any[]
      conflicts: { period: string; reason: string; public_source: string; diff: any[] }[]
      validation: TableValidation
    }>(`/api/tables/${id}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overwrite }),
    }),

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

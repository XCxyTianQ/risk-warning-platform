/** 常驻用量/成本状态（底部状态栏与对话面板共享） */

import { reactive } from 'vue'

export interface UsageStats {
  llm_calls: number
  prompt_tokens: number
  completion_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  cache_hit_rate: number
  est_cost: number
  compact_count: number
}

export interface GlobalUsage extends UsageStats {
  sessions: number
}

export const usageState = reactive({
  apiOk: null as boolean | null,
  model: '',
  contextWindow: 128000,
  sessionId: '' as string,
  session: null as (UsageStats & { title?: string }) | null,
  global: null as GlobalUsage | null,
  lastPromptTokens: 0,   // 最近一次调用的输入 token（用于上下文压力条）
  compacting: false,
})

export function setSessionUsage(u: UsageStats | null, sessionId = '') {
  usageState.session = u
  if (sessionId) usageState.sessionId = sessionId
}

export function setGlobalUsage(payload: any) {
  usageState.model = payload.model ?? usageState.model
  usageState.contextWindow = payload.context_window ?? usageState.contextWindow
  usageState.global = payload.global ?? null
  if (payload.session) {
    usageState.session = payload.session
    usageState.sessionId = payload.session.session_id
  }
}

/** 上下文压力（最近一次输入 token / 窗口） */
export function contextPressure(): { pct: number; color: string } {
  const win = usageState.contextWindow || 1
  const used = usageState.lastPromptTokens || usageState.session?.prompt_tokens || 0
  const pct = Math.min(100, Math.round((used / win) * 100))
  const color = pct >= 80 ? 'var(--danger)' : pct >= 60 ? 'var(--warn)' : 'var(--ok)'
  return { pct, color }
}

export function hitColor(rate: number): string {
  if (rate >= 0.8) return 'var(--ok)'
  if (rate >= 0.5) return 'var(--warn)'
  return 'var(--danger)'
}

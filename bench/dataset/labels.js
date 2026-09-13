/**
 * bench/dataset/labels.js —— 风险事件标签词典（T5 的"真值"来源定义）
 *
 * 原则：
 *  1. **只用权威、可回溯的信源**：巨潮资讯（交易所指定披露平台）的公告全文检索，
 *     每条标签都带 公告标题 + 披露日期 + PDF 链接，任何人可以点开核对；
 *  2. **标签是"事件"而不是"印象"**：类型 + 日期 + 证据，才能算提前预警期（lead time）；
 *  3. 关键词是**可审计**的：改词表＝改标签口径，必须在 manifest 里留痕。
 */

/** 事件类型 —— severity 用于分层评估（高危事件单独看召回） */
const EVENT_TYPES = [
  {
    type: 'regulatory_penalty',
    label: '行政处罚',
    severity: 'high',
    // 命中这些词才算"公司/责任人被处罚"，避免把"未被处罚"的澄清公告算进来
    keywords: ['行政处罚决定书', '行政处罚事先告知书', '行政处罚'],
    exclude: ['不存在应披露而未披露', '未被处罚', '撤销行政处罚', '不予行政处罚'],
  },
  {
    type: 'investigation',
    label: '立案调查',
    severity: 'high',
    keywords: ['立案调查', '立案告知书', '证监会立案'],
    exclude: ['结案', '终止调查', '不予立案'],
  },
  {
    type: 'delisting_risk',
    label: '退市风险警示',
    severity: 'high',
    keywords: ['退市风险警示', '终止上市', '被实施退市风险警示'],
    exclude: ['申请撤销', '撤销退市风险警示'],
  },
  {
    type: 'other_risk_warning',
    label: '其他风险警示',
    severity: 'medium',
    keywords: ['其他风险警示'],
    exclude: ['申请撤销', '撤销其他风险警示'],
  },
  {
    type: 'debt_default',
    label: '债务违约',
    severity: 'high',
    keywords: ['债务违约', '逾期债务', '无法按期偿还'],
    exclude: ['不存在', '已偿还'],
  },
  {
    type: 'funds_occupation',
    label: '资金占用/违规担保',
    severity: 'medium',
    keywords: ['资金占用', '违规担保'],
    exclude: ['不存在', '已解决', '已归还'],
  },
  {
    type: 'fraud',
    label: '财务造假/会计差错',
    severity: 'high',
    keywords: ['财务造假', '虚假记载', '会计差错更正'],
    exclude: ['不存在', '未被认定'],
  },
  {
    type: 'enforcement',
    label: '被执行/失信',
    severity: 'high',
    keywords: ['失信被执行人', '限制消费令', '被执行人'],
    exclude: ['不存在', '已解除', '已撤销'],
  },
  {
    type: 'audit_qualified',
    label: '非标审计意见',
    severity: 'medium',
    keywords: ['无法表示意见', '保留意见', '非标准审计意见'],
    exclude: ['标准无保留意见', '内部控制审计报告'],
  },
]

/**
 * T5 预测目标（可选项，供打分器切换）：
 *  - risk_warning_next_year：未来 12 个月内是否出现"退市风险警示/终止上市"（高危、样本量足）
 *  - penalty_next_year：未来 12 个月内是否收到行政处罚/立案调查
 *  - any_high_event_next_year：任一年度内是否出现任一 high 事件
 */
const TARGETS = {
  risk_warning_next_year: { label: '未来 12 个月被实施退市风险警示/终止上市', types: ['delisting_risk'] },
  penalty_next_year: { label: '未来 12 个月受到行政处罚或立案调查', types: ['regulatory_penalty', 'investigation'] },
  any_high_event_next_year: { label: '未来 12 个月出现任一高危事件', severity: 'high' },
}

/** 一条公告是否命中某事件类型 */
function matchEvent(type, title) {
  const rule = EVENT_TYPES.find((e) => e.type === type)
  if (!rule) return null
  const t = String(title || '').replace(/<[^>]+>/g, '')
  const hit = rule.keywords.find((k) => t.includes(k))
  if (!hit) return null
  if ((rule.exclude || []).some((k) => t.includes(k))) return null
  return { type, severity: rule.severity, keyword: hit }
}

/** 扫描标题，返回所有命中事件（一条公告可能同时含多个关键词） */
function classifyTitle(title) {
  const out = []
  for (const rule of EVENT_TYPES) {
    const m = matchEvent(rule.type, title)
    if (m) out.push(m)
  }
  return out
}

module.exports = { EVENT_TYPES, TARGETS, classifyTitle, matchEvent }

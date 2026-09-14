/**
 * 口径 B（平台链路）的预设组定义——供 platform-chain.js 与 chain-arms.js 共用，
 * 避免两处各写一份提示词导致"同一组实验其实是两套配置"。
 */

const SKILL = {
  name: '客观题作答',
  description: '金融客观题作答：严格输出契约，禁止调工具',
  content: [
    '本技能用于金融类客观题（单选/多选/判断）。',
    '输出契约（必须严格遵守）：',
    '1. 只输出选项字母本身；单选输出一个字母，多选把字母连写（例如 ABDE），判断输出"对"或"错"。',
    '2. 禁止输出任何解释、分析、标点、Markdown 强调符号或前后缀文字。',
    '3. 不要调用任何平台工具：这类题目考查通用金融知识，平台企业数据工具无法作答。',
    '4. 若确实无法确定，输出你认为最可能的字母，不要留空。',
  ].join('\n'),
}

const PROMPT_FIX = [
  '[作答模式]',
  '- 若问题属于通用金融知识、职业资格考试、概念辨析等**不依赖平台企业数据**的题目：',
  '  直接依据知识作答，**不要调用任何工具**，也不要因为"没有工具结果"而拒答或含糊；',
  '- 客观选择题只输出选项字母（多选连写，如 ABDE），不要输出解释或 Markdown 强调；',
  '- 只有当问题确实需要企业数据（某公司财务、风险、事件、评分）时才调用工具。',
].join('\n')

/** 注意：平台 retain_whitelist 把**空数组当作"不过滤"**，"去工具"必须传匹配不到任何工具的白名单 */
const NO_TOOLS = ['__none__']

const LIST = [
  { id: 'B0', label: '基线（平台现状）', promptExtra: '', tools: null, skill: null },
  { id: 'B1', label: '仅去工具', promptExtra: '', tools: NO_TOOLS, skill: null },
  { id: 'B2', label: '仅改提示', promptExtra: PROMPT_FIX, tools: null, skill: null },
  { id: 'B3', label: '改提示 + 去工具', promptExtra: PROMPT_FIX, tools: NO_TOOLS, skill: null },
  { id: 'B4', label: '改提示 + 载入技能', promptExtra: PROMPT_FIX, tools: null, skill: SKILL },
  { id: 'B5', label: '改提示 + 去工具 + 载入技能', promptExtra: PROMPT_FIX, tools: NO_TOOLS, skill: SKILL },
]

module.exports = { LIST, SKILL, PROMPT_FIX, NO_TOOLS, byId: (id) => LIST.find((a) => a.id === id) || null }

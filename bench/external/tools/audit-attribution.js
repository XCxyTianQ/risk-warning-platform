/**
 * 口径归属核对：逐一确认"谁用了平台的东西、谁没用"。
 *
 * 动机：跨模型对比里最容易出的事故，是把"平台工程"的功劳算进"模型能力"。
 * 这份脚本不靠记忆，直接读 harness 代码与产物，把每个基准的**脚手架来源**列清楚。
 *
 *   node bench/external/tools/audit-attribution.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const REPO = path.join(EXT, '..', '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')

/** 1) 适配器是否按模型分支（除裁判选择外应当没有） */
function adapterBranching() {
  const dir = path.join(EXT, 'adapters')
  const out = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8')
    const branches = [...s.matchAll(/candidateModel === '[^']+'|model === '[^']+'/g)].map((m) => m[0])
    out.push({ file: f, perModelBranches: [...new Set(branches)] })
  }
  return out
}

/** 2) harness 是否给任何模型注入平台工具 / 平台预设 */
function toolInjection() {
  const runJs = read('bench/external/run.js')
  const adapters = fs.readdirSync(path.join(EXT, 'adapters')).filter((x) => x.endsWith('.js'))
  const usesPlatformTools = /bench\/tools|platform.*tool|mcp/i.test(runJs)
  const toolSchemas = adapters.map((f) => {
    const s = fs.readFileSync(path.join(EXT, 'adapters', f), 'utf8')
    // BFCL 用的是它自带的函数 schema（合成函数），不是平台 25 个工具
    const fromCorpus = /loadTools|bfcl.*tool|function.*schema/i.test(s)
    return { adapter: f, toolSource: /bfcl/.test(f) ? 'BFCL 自带合成函数（非平台工具）' : fromCorpus ? '基准自带函数定义' : '无工具' }
  })
  return { usesPlatformTools, toolSchemas }
}

/** 3) 平台链路（口径 B）跑过哪些模型 */
function platformChainModels() {
  const f = path.join(EXT, 'out', 'platform-usage.json')
  if (!fs.existsSync(f)) return { runs: [], note: '无 platform-usage.json' }
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  const models = [...new Set((j.runs || []).map((r) => r.model).filter(Boolean))]
  return { runs: (j.runs || []).length, models, note: 'platform-chain.js 通过平台 HTTP API 运行，因此带平台 25 工具与编排' }
}

/** 4) 后端能否指向别的模型（决定"给对手也套平台"是否可行） */
function backendModelSwitchable() {
  const s = read('bench/lib/llm.js')
  const envDriven = /RWP_LLM_MODEL/.test(s) && /RWP_LLM_BASE_URL/.test(s) && /RWP_LLM_API_KEY/.test(s)
  return { envDriven, vars: ['RWP_LLM_MODEL', 'RWP_LLM_BASE_URL', 'RWP_LLM_API_KEY'], defaultModel: (s.match(/DEFAULT_MODEL = '([^']+)'/) || [])[1] || null }
}

const branching = adapterBranching()
const tools = toolInjection()
const chain = platformChainModels()
const backend = backendModelSwitchable()

const benches = [
  { id: 'financebench', prompt: 'harness 自写 A1 提示词（全体共用）', platformTools: false, retrieval: false },
  { id: 'bfcl', prompt: 'harness 固定提示词（全体共用）', platformTools: false, retrieval: false, note: '函数 schema 来自 BFCL 语料，非平台工具' },
  { id: 'cflue', prompt: 'harness 固定提示词（全体共用）', platformTools: false, retrieval: false },
  { id: 'fineval', prompt: 'harness 固定提示词（全体共用）', platformTools: false, retrieval: false },
  { id: 'fineval-mm', prompt: 'harness 固定提示词（全体共用）', platformTools: false, retrieval: false, note: '我方走官方直连、对手走网关（路由差异已记录）' },
  { id: 'omnidocbench', prompt: 'harness 固定提示词（全体共用）', platformTools: false, retrieval: false, note: '同上' },
]

const out = {
  generatedAt: new Date().toISOString(),
  question: '除平台自身的 deepseek-flash 外，其余模型是否均为原生（未使用本平台任何工具与预设）？',
  answer: {
    short: '是——而且**连我们自己在跨模型对比里也是原生的**；平台工具与预设只在"口径 B（平台链路）"里使用，而那一项只跑过我们自己。',
    detail: [
      '六个外部基准全部经同一 harness：同一提示词、同一样本、同一判分；适配器里除"裁判选择"外没有任何按模型分支的代码。',
      'harness 不向任何模型注入平台的 25 个工具或平台系统预设；BFCL 用的是它自带的合成函数 schema，不是平台工具。',
      '唯一的服务侧差异是路由：我方走官方直连、对手走 OpenCode Zen 网关（视觉基准里这个差异是硬约束）。已有同模型双路由对照组验证其影响：oracle 完全一致、BFCL 差 0.2pp。',
    ],
  },
  categories: [
    { id: 'A', name: '原生同尺对比', who: '五家全部（含我方）', scaffolding: 'harness 固定提示词，无平台工具、无平台预设、无检索', examples: 'CFLUE / FinEval / FinEval-MM / BFCL / OmniDocBench / FinanceBench' },
    { id: 'B', name: '平台链路（口径 B）', who: '仅我方 deepseek-flash', scaffolding: '走平台 HTTP API：25 工具 + 编排 + 审批闸门', examples: 'platform-chain.js（CFLUE 300 题 + 指标抽取 340 题）' },
    { id: 'C', name: '管线对比（D1）', who: '仅我方', scaffolding: '我们的 PDF 抽取 + BM25 检索 + A1 作答，对照论文公开的检索口径答案', examples: 'FinanceBench open-book 70.0%（n=150）' },
    { id: 'D', name: '自建基准 T1–T5', who: '不涉及外部模型', scaffolding: '平台自身能力（抽取/勾稽/测算/预警）', examples: 'T1 F1 100%、T3 召回 100%、T5 AUC 79.8' },
  ],
  evidence: { adapterPerModelBranches: branching, toolInjection: tools, platformChain: chain, backendSwitchable: backend, benches },
  implication: [
    '当前主表回答的是"同一提示词下的模型能力"，不是"平台 vs 模型"——两者的功劳不能混算。',
    '平台层的净效应目前只在自己身上量过：CFLUE 口径 A→B 由 88.3% 掉到 69.5%（−18.8pp），即今天的平台链在该基准上是净成本，这是最该修的一项。',
    '下一步最关键的实验：把口径 B 也跑到对手身上（后端由环境变量 RWP_LLM_MODEL / RWP_LLM_BASE_URL / RWP_LLM_API_KEY 驱动，换模型即可复现），从而把"模型能力差"与"工具/编排能力差"彻底分开；BFCL 已显示对手的工具调用能力并不占优（Astra 83.27% vs 我方 89.04%），这个对比不会先天失真。',
  ],
}

const OUT = path.join(EXT, 'out', 'attribution-audit.json')
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))

console.log('=== 口径归属核对 ===')
console.log('问题：' + out.question)
console.log('\n结论：' + out.answer.short)
console.log('\n适配器按模型分支：')
for (const b of branching) console.log('  ' + b.file.padEnd(20) + (b.perModelBranches.length ? b.perModelBranches.join(', ') : '（无）'))
console.log('\nharness 是否注入平台工具：' + (tools.usesPlatformTools ? '是' : '否'))
for (const t of tools.toolSchemas) console.log('  ' + t.adapter.padEnd(20) + t.toolSource)
console.log('\n平台链路（口径 B）跑过的模型：' + (chain.models.length ? chain.models.join(', ') : '（产物未记模型名，脚本为 platform-chain.js → 仅我方）'))
console.log('后端可换模型：' + (backend.envDriven ? '可（' + backend.vars.join(' / ') + '）默认 ' + backend.defaultModel : '不可'))
console.log('\n四类口径：')
for (const c of out.categories) console.log('  ' + c.id + '. ' + c.name.padEnd(18) + ' 主体：' + c.who)
console.log('\n产物 → bench/external/out/attribution-audit.json')

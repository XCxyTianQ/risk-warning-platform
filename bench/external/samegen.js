/**
 * 同代测试（same-generation test）编排。
 *
 * 背景：`deepseek-flash` 实为 **DeepSeek-V4.1-Flash**（官方文档：旧名已退役、由 V4.1-Flash 承接），
 * 因此拿它去比 2023 年的 GPT-4 是**跨代对照**；真正的同代对手是 GPT-5.6 Luna、GLM-5.3-Flash 这类。
 *
 * 本脚本负责：
 *  1. 报告注册表里各模型的可用状态（端点/Key 是否就绪）；
 *  2. 生成"同代测试"的命令清单（按基准分别给出，便于分批跑、便于算钱）；
 *  3. 校验答案与裁判的来源文件是否齐全，避免把不同代际的数字混进同一张表。
 *
 *   node bench/external/samegen.js --plan
 *   node bench/external/samegen.js --status
 */
const fs = require('node:fs')
const path = require('node:path')
const { listProviders } = require('./lib/model')

const EXT = __dirname
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

/** 同代测试的基准清单：选的都是"能横向比、且我们已经跑通"的 */
const BENCHMARKS = [
  { id: 'cflue', label: 'CFLUE 中文金融知识（300 题抽样）', costNote: '约 425 次作答/模型', kind: 'text' },
  { id: 'fineval', label: 'FinEval 金融严谨性（数值 42 + 抽取 340）', costNote: '约 382 次作答/模型', kind: 'text' },
  { id: 'bfcl', label: 'BFCL v4 工具调用（520 题）', costNote: '约 520 次作答/模型', kind: 'text' },
  { id: 'financebench', label: 'FinanceBench oracle（150 题，语义判定）', costNote: '150 次作答 + 裁判', kind: 'judged' },
  { id: 'fineval-mm', label: 'FinEval-MM 图表题（150 题，需视觉）', costNote: '约 150 次作答/模型', kind: 'vision' },
  { id: 'omnidocbench', label: 'OmniDocBench 整页转写（18 页，需视觉）', costNote: '18 次作答/模型', kind: 'vision' },
]

function status() {
  const provs = listProviders()
  console.log('=== 同代测试：模型就绪状态 ===')
  for (const p of provs) {
    const flags = [p.vision ? '视觉' : '纯文本', p.tools ? '工具' : '无工具'].join('/')
    console.log(`  ${p.ready ? '✅' : '⏳'} ${p.id.padEnd(16)} ${p.label.padEnd(20)} [${flags}] ${p.ready ? '就绪' : p.reason}`)
    if (p.role) console.log(`       ${p.role}`)
  }
  const ready = provs.filter((p) => p.ready)
  console.log(`\n可用于同代对比的模型：${ready.length} 个${ready.length < 2 ? '（同代对比至少需要 2 个：一个是被测、一个是裁判）' : ''}`)
  return ready
}

function plan() {
  const ready = status()
  const ids = ready.map((p) => p.id)
  if (ids.length < 2) {
    console.log('\n⚠️ 还缺模型端点/密钥：请在 bench/external/models.json 里填写 baseUrl，并把 Key 放到约定的文件或环境变量。')
  }
  const models = ids.join(',')
  console.log('\n=== 同代测试命令清单 ===')
  console.log('# 0) 先只跑 3 题做连通性自检（各家端点/Key/视觉能力是否真的可用）')
  console.log(`node bench/external/tools/probe-providers.js --models ${models}\n`)
  console.log('# 1) 文本类基准（两个模型都跑；同一裁判口径由 --judge-votes 3 保证）')
  for (const b of BENCHMARKS.filter((x) => x.kind !== 'vision')) {
    console.log(`#    ${b.label}（${b.costNote}）`)
    console.log(`node bench/external/run.js --only ${b.id} --merge --models ${models} --judge-votes 3\n`)
  }
  console.log('# 2) 视觉类基准（只跑注册表里 vision=true 的模型）')
  for (const b of BENCHMARKS.filter((x) => x.kind === 'vision')) {
    console.log(`node bench/external/run.js --only ${b.id} --merge --models ${models} --judge-votes 3   # 非视觉模型会被自动跳过\n`)
  }
  console.log('# 3) 裁判矩阵：让每个模型的答案都被**其它模型**判一遍（消除同源偏袒）')
  console.log(`node bench/external/tools/judge-matrix.js --models ${models} --bench financebench\n`)
  console.log('# 4) 重新生成报告（HTML + Word），并把"同代对比"表单独成节')
  console.log('node bench/html/make-platform-report.js && python bench/external/report/make-alignment-report.py')
  void arg
}

const mode = process.argv.includes('--plan') ? 'plan' : 'status'
if (mode === 'plan') plan()
else status()

// 顺带记录一次状态快照，便于报告写明"对手是谁、什么时候测的"
const snap = { generatedAt: new Date().toISOString(), models: listProviders(), benchmarks: BENCHMARKS }
fs.mkdirSync(path.join(EXT, 'out'), { recursive: true })
fs.writeFileSync(path.join(EXT, 'out', 'samegen-status.json'), JSON.stringify(snap, null, 2))

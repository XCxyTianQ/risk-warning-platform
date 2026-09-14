/**
 * 外部基准的**版本锁定清单**：哪一个基准、哪个 commit/分支、哪些文件、sha256 是多少。
 *
 * 原则（写进报告的"口径"一节）：
 *  - 只做抽样，不宣称跑过全量；
 *  - 每个文件在首次抓取时记 sha256，之后重跑若哈希变化必须显式 --refresh，避免"悄悄换了题"；
 *  - 原始数据不入仓库（体积/许可），入仓库的只有本清单与评测产物。
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('./lib/fetch')

const REFS = {
  cflue: { repo: 'aliyun/cflue', ref: 'master' },
  fineval: { repo: 'SUFE-AIFLM-Lab/FinEval', ref: 'main' },
  financebench: { repo: 'patronus-ai/financebench', ref: 'main' },
  bfcl: { repo: 'ShishirPatil/gorilla', ref: 'main' },
  omnidocbench: { repo: 'opendatalab/OmniDocBench', ref: 'main' },
}

/** 基准元信息：论文/仓库/用来回答什么问题/我们哪一层与之对应 */
const BENCHMARKS = {
  cflue: {
    id: 'cflue',
    title: 'CFLUE',
    fullName: 'CFLUE: A Benchmark for Chinese Financial Language Understanding (ACL 2024 Findings)',
    paper: 'https://aclanthology.org/2024.findings-acl.337/',
    repo: 'https://github.com/aliyun/cflue',
    layer: '模型层（中文金融知识与指令遵循）',
    question: '平台所有解释、摘要、风险定性判断所依赖的模型底座，在中文金融语境下够不够用',
    officialMetric: '单项选择题准确率（utils/compute_score.py: acc_score）；生成类任务 BLEU-1/4、ROUGE-1/2/L、BERTScore',
    sampling: '知识题从 3,864 题中固定种子抽 300；应用题 125 条全量',
  },
  fineval: {
    id: 'fineval',
    title: 'FinEval (Financial Rigor Test + FinEval-MM 子集)',
    fullName: 'FinEval: A Chinese Financial Domain Knowledge Evaluation Benchmark (NAACL 2025)',
    paper: 'https://aclanthology.org/2025.naacl-long.318.pdf',
    repo: 'https://github.com/SUFE-AIFLM-Lab/FinEval',
    layer: '数值严谨性层 + 多模态读取层',
    question: '从检索文本里做金融数值计算与指标抽取、以及从财报图表截图里取数，是否可靠',
    officialMetric: '严谨性测试按标准答案判对错；多模态题为四选一准确率',
    sampling: '数值计算 42 条全量；指标抽取抽 300；多模态图题按类型分层抽 150',
  },
  financebench: {
    id: 'financebench',
    title: 'FinanceBench (open-source split)',
    fullName: 'FinanceBench: A New Benchmark for Financial Question Answering',
    paper: 'https://arxiv.org/abs/2311.11944',
    repo: 'https://github.com/patronus-ai/financebench',
    layer: '财报文档问答层（数值作答 + 证据引用）',
    question: '给定财报证据能否给出可核验的数值答案，以及"无证据时该不该拒答"',
    officialMetric: 'answer accuracy（论文用 GPT-4 作为裁判）；仓库内附论文各模型的逐题结果，可作外部锚点',
    sampling: '开源子集 150 题全量 × {oracle 给证据, closedBook 不给证据}',
  },
  bfcl: {
    id: 'bfcl',
    title: 'BFCL v4 (Berkeley Function Calling Leaderboard)',
    fullName: 'BFCL V4: Berkeley Function Calling Leaderboard',
    paper: 'https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html',
    repo: 'https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard',
    layer: '工具调用层（平台 25 个工具 + MCP 的底座能力）',
    question: '模型能不能选对函数、填对参数，以及在没有合适函数时能不能不调用',
    officialMetric: 'AST 匹配（函数名 + 参数值集合）+ 不可执行类判分；本仓库为自实现等价判定，非官方 checker',
    sampling: 'simple_python 抽 200、multiple 抽 200、irrelevance 抽 120',
  },
  omnidocbench: {
    id: 'omnidocbench',
    title: 'OmniDocBench (demo 子集)',
    fullName: 'OmniDocBench: Benchmarking Diverse PDF Document Parsing with Comprehensive Annotations',
    paper: 'https://arxiv.org/abs/2412.07626',
    repo: 'https://github.com/opendatalab/OmniDocBench',
    layer: '文档读取层（页面图像 → 结构化文本）',
    question: '把中文财报/研报页面图交给多模态模型读，文字与数字能不能读全',
    officialMetric: '文本编辑距离、公式 CDM、表格 TEDS、阅读顺序编辑距离（官方实现为 Python，本仓库只做文本保真度与数字召回，口径见报告）',
    sampling: 'demo 18 页全量',
  },
}

/** 固定抓取清单（体积小、必然用到） */
const FIXED = [
  { b: 'cflue', key: 'cflue/knowledge.json', path: 'data/knowledge/knowledge.json', desc: 'CFLUE 财务知识单选 3,864 题（含答案）' },
  { b: 'cflue', key: 'cflue/application.json', path: 'data/application/application.json', desc: 'CFLUE 金融文本应用 125 条（含参考输出）' },
  { b: 'cflue', key: 'cflue/compute_score.py', path: 'utils/compute_score.py', desc: 'CFLUE 官方判分口径（用于对齐指标定义）' },
  { b: 'cflue', key: 'cflue/README_zh.md', path: 'README_zh.md', desc: 'CFLUE 中文说明' },

  { b: 'fineval', key: 'fineval/rigor_numerical.csv', path: 'Financial Rigor Test/Financial Rigor Test_Numerical Calculation.csv', desc: 'FinEval 金融严谨性-数值计算 42 题（含标准答案与计算逻辑）' },
  { b: 'fineval', key: 'fineval/rigor_index.csv', path: 'Financial Rigor Test/Financial Rigor Test_Index Extraction.csv', desc: 'FinEval 金融严谨性-指标抽取（含参考答案）' },

  { b: 'financebench', key: 'financebench/open_source.jsonl', path: 'data/financebench_open_source.jsonl', desc: 'FinanceBench 开源子集 150 题（含答案/证据/理由）' },
  { b: 'financebench', key: 'financebench/results_gpt4_oracle.jsonl', path: 'results/gpt-4_oracle.jsonl', desc: '论文公开结果：GPT-4 oracle 模式逐题作答与标签（外部锚点）' },
  { b: 'financebench', key: 'financebench/results_gpt4_closedbook.jsonl', path: 'results/gpt-4_closedBook.jsonl', desc: '论文公开结果：GPT-4 闭卷模式' },
  { b: 'financebench', key: 'financebench/results_gpt4_1106_oracle.jsonl', path: 'results/gpt-4-1106-preview_oracle.jsonl', desc: '论文公开结果：GPT-4-1106 oracle' },
  { b: 'financebench', key: 'financebench/results_claude2_incontext.jsonl', path: 'results/claude-2_inContext.jsonl', desc: '论文公开结果：Claude-2 in-context' },
  { b: 'financebench', key: 'financebench/results_llama2_singlestore.jsonl', path: 'results/llama2_singleStore.jsonl', desc: '论文公开结果：Llama2-70B single-store' },

  { b: 'bfcl', key: 'bfcl/simple_python.jsonl', path: 'berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_simple_python.json', desc: 'BFCL v4 simple (python 函数) 400 题' },
  { b: 'bfcl', key: 'bfcl/ans_simple_python.jsonl', path: 'berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_simple_python.json', desc: 'BFCL v4 simple 标准答案' },
  { b: 'bfcl', key: 'bfcl/multiple.jsonl', path: 'berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_multiple.json', desc: 'BFCL v4 multiple 题面' },
  { b: 'bfcl', key: 'bfcl/ans_multiple.jsonl', path: 'berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_multiple.json', desc: 'BFCL v4 multiple 标准答案' },
  { b: 'bfcl', key: 'bfcl/irrelevance.jsonl', path: 'berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_irrelevance.json', desc: 'BFCL v4 irrelevance（无合适函数时不该调用）' },

  { b: 'omnidocbench', key: 'omnidocbench/demo.json', path: 'demo_data/omnidocbench_demo/OmniDocBench_demo.json', desc: 'OmniDocBench demo 18 页标注（版面框 + 类别 + 文本）' },
  { b: 'omnidocbench', key: 'omnidocbench/README_zh-CN.md', path: 'README_zh-CN.md', desc: 'OmniDocBench 中文说明（指标定义出处）' },
]

/** FinEval-MM（multimodeldata）：15 个题型文件，题目里带图表/财报截图路径 */
const FINEVAL_MM = [
  'multimodeldata/Financial Analysis and Business Decision/Financial_Market_Sentiment_Analysis.tsv',
  'multimodeldata/Financial Analysis and Business Decision/Financial_Scenario_Analysis.tsv',
  'multimodeldata/Financial Analysis and Business Decision/Industry_Analysis_and_Inference.tsv',
  'multimodeldata/Financial Analysis and Business Decision/Investment_Analysis.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Candlestick_Chart_Analysis.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Financial_Data_Statistics.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Financial_Entity_Relationships_Interpretation.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Financial_Indicator_Assessment.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Financial_Information_Extraction.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Financial_Seal_Recognition.tsv',
  'multimodeldata/Financial Knowledge and Data Analysis/Stock_Selection_Strategies_Backtesting.tsv',
  'multimodeldata/Financial Risk Control and Asset Optimization/Asset_Allocation_Analysis.tsv',
  'multimodeldata/Financial Risk Control and Asset Optimization/Financial_Data_Reasoning_and_Interpretation.tsv',
  'multimodeldata/Financial Risk Control and Asset Optimization/Financial_Risk_and_Policy_Analysis.tsv',
  'multimodeldata/Financial Risk Control and Asset Optimization/Financial_Strategy_Optimization.tsv',
]

/** 固定清单之外、按题目逐条抓取的资源（页面图/图表截图），也走同一个缓存 */
async function repoFile(b, repoPath, keyOverride, opts) {
  const { repo, ref } = REFS[b]
  const key = keyOverride || `${b}/${repoPath.split('/').pop()}`
  const meta = await F.fetchToCache(key, F.ghRaw(repo, ref, repoPath), { binary: true, ...opts })
  return { ...meta, repoPath, sourceUrl: F.ghBlob(repo, ref, repoPath) }
}

/** 抓取 FinEval-MM 的 15 个题型文件（体积小，但只做抽样） */
async function ensureFinevalMM({ refresh = false, log = () => {} } = {}) {
  const out = []
  for (const p of FINEVAL_MM) {
    const meta = await repoFile('fineval', p, `fineval/mm_${p.split('/').pop()}`, { force: refresh })
    out.push({ repoPath: p, key: `fineval/mm_${p.split('/').pop()}`, bytes: meta.bytes, sha256: meta.sha256, fromCache: meta.fromCache })
    log(`  ${meta.fromCache ? '缓存' : '下载'}  ${String((meta.bytes / 1024).toFixed(0) + 'KB').padStart(6)}  ${p.split('/').pop()}`)
  }
  return out
}

/**
 * 仓库文件树（GitHub API，带磁盘缓存）。
 * 用途：**先确认资源真的存在**再评测。
 * 反例（已踩）：FinEval-MM 的题目引用 data/figure/pg/xxx.jpg，而仓库里根本没有 figure/pg 目录，
 * 不先查树就会在评测中途大量 404，既浪费时间，也容易把"数据拿不到"错记成"模型答错"。
 */
async function repoTree(b, { refresh = false } = {}) {
  const cacheDir = F.ensureDir(path.join(F.CACHE_DIR, 'trees'))
  const file = path.join(cacheDir, `${b}.json`)
  if (!refresh && fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j.tree || j
  }
  const { repo, ref } = REFS[b]
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers: F.UA })
  if (!res.ok) throw new Error(`获取仓库树失败 ${repo}@${ref}: HTTP ${res.status}`)
  const j = await res.json()
  fs.writeFileSync(file, JSON.stringify(j))
  return j.tree || []
}

/** 仓库内实际存在的文件路径集合（用于判定"资源是否可得"） */
async function repoPathSet(b) {
  const tree = await repoTree(b)
  return new Set(tree.filter((x) => x.type === 'blob').map((x) => x.path))
}

async function ensureFixed({ refresh = false, log = console.log } = {}) {
  const manifest = []
  for (const f of FIXED) {
    const { repo, ref } = REFS[f.b]
    const meta = await F.fetchToCache(f.key, F.ghRaw(repo, ref, f.path), { force: refresh })
    manifest.push({
      benchmark: f.b,
      desc: f.desc,
      repo: `${repo}@${ref}`,
      repoPath: f.path,
      sourceUrl: F.ghBlob(repo, ref, f.path),
      bytes: meta.bytes,
      sha256: meta.sha256,
      fromCache: meta.fromCache,
      fetchedAt: meta.fetchedAt,
    })
    log(`  ${meta.fromCache ? '缓存' : '下载'}  ${String((meta.bytes / 1024).toFixed(0) + 'KB').padStart(7)}  ${meta.sha256.slice(0, 12)}  ${f.desc}`)
  }
  return manifest
}

module.exports = { REFS, BENCHMARKS, FIXED, FINEVAL_MM, repoFile, repoTree, repoPathSet, ensureFixed, ensureFinevalMM }

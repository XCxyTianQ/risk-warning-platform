# 外部基准对齐（M4）

> 一句话：**把"我们自己的数字"放进外部可比坐标系里**——选 6 组公开基准、锁定版本与哈希、
> 固定种子抽样、两个模型横向跑，并把"我们改了什么提示词、判分器可不可信、哪些数据根本拿不到"全部写清楚。

本目录是对齐工作的全部代码与产物。它与 `bench/`（回归测试与工程指标）、`bench/benchmark/`（自建 FinRisk-Bench）
是三件不同的事，报告里必须分开写，不能混成一个"总分"。

```
bench/external/
├── sources.js            版本锁定清单：哪个基准、哪个仓库、哪些文件（声明式）
├── prepare.js            一次性抓齐 + 许可证核查 + 题库盘点 → out/manifest.json
├── run.js                编排入口（--dry / --small / --medium / --only / --models / --validate-only / --merge）
├── platform-chain.js     口径 B：把同一批题送进平台真实链路（/api/chat/stream + 附件读取）复测
├── lib/
│   ├── fetch.js          带磁盘缓存 + sha256 的下载层（命中缓存即零网络）
│   ├── model.js          /chat/completions 客户端：文本 / 图像 / 函数调用 + token 记账
│   ├── sample.js         固定种子抽样（含分层抽样），产出样本哈希
│   ├── grade.js          判分器：选择题、数值（含量纲换算）、语句召回、文本保真、BFCL AST 判定
│   └── kit.js            BFCL schema 转换、裁判提示词、Wilson 置信区间、分组聚合
├── adapters/             6 个基准的适配器（见下表）
├── report/               从 JSON 产物生成 Word/Markdown 报告（不手抄数字）
├── probes/               侦查记录：先证明"数据能拿到、答案存在、通道可用"，再写评测代码
├── tools/
│   ├── preflight.js      出数前的数据校验（映射、答案、路径是否真的存在）
│   ├── peek-model.js     单次调用的原始返回（排查"空输出""被截断"等问题）
│   └── fetch-reference-numbers.js  抓外部公开对照数字并记录出处
├── cache/                原始数据缓存（不入库）
├── out/                  逐题明细与清单（明细不入库，manifest.json 入库）
└── reports/              聚合报告（入库）：external-alignment-v1.json / .md
```

## 一、跑了哪些外部基准，分别回答什么问题

| # | 基准 | 对应平台层级 | 用来回答 | 本轮口径与抽样 |
|---|---|---|---|---|
| E1 | **CFLUE**（ACL 2024 Findings） | 模型层 | 平台所有解释、摘要、定性判断所依赖的中文金融底座够不够用 | 知识题 3,864 → 抽 300；应用题 125 全量 |
| E2 | **FinEval 金融严谨性**（NAACL 2025） | 数值严谨性层 | 从给定检索内容做金融数值计算与指标抽取，准不准 | 数值计算 42 全量；指标抽取 340 → 抽 340 |
| E2b | **FinEval-MM**（多模态子集） | 多模态读取层 | 从财报/研报图表截图里取数，读得对不对 | 可用题池 371 → 分层抽 150 |
| E3 | **FinanceBench**（开源子集） | 财报问答层 | 有证据时能否给出可核验的数值答案；无证据时会不会硬答 | 150 题全量 × {oracle, closedBook} |
| E4 | **BFCL v4**（非实时子集） | 工具调用层 | 25 个工具 + MCP 的底座模型能不能选对函数、填对参数、忍住不调用 | simple 200 / multiple 200 / irrelevance 120 |
| E5 | **OmniDocBench**（demo 子集） | 文档读取层 | 整页中文研报/杂志/报纸图像转写，文字与数字读全没有 | demo 18 页全量 |

## 二、六条不可让步的口径

1. **不全量跑，但抽样可复现**：固定种子（默认 20260101）+ 样本哈希写进报告；同一份数据 + 同一个种子 = 同一批题。
2. **版本锁定**：每个文件记录 `repo@ref` 与 sha256（`out/manifest.json`），哈希变化必须显式 `--refresh`，避免"悄悄换了题"。
3. **提示词尽量用官方原文**：FinEval 严谨性、BFCL、OmniDocBench 均使用官方题面原文；CFLUE/FinanceBench 因需要指定输出格式而在报告里逐条写明我方添加的系统提示词。
4. **判分能用确定性规则就不交给模型**：只有 FinanceBench 需要语义等价判断时才用 LLM 裁判，且**用另一个模型判**（避免同源偏好），并用论文公开标签反向验证判分器。
5. **自实现的判分器必须自曝**：BFCL 的 AST 判定、FinEval 的语句/数字召回、OmniDocBench 的保真度指标都是自实现，报告里一律标注"非官方 checker / 非官方指标，不得与官方榜单分数等同"。
6. **拿不到的数据要作为结论写出来**：例如 FinEval-MM 引用的 `figure/pg`、`figure/sdt` 等目录仓库根本没发布、HF 镜像返回 401；这类事实与"模型答错"是两件事。

## 三、被测模型与能力边界（实测，不是假设）

本项目获批使用的模型是 **`deepseek-flash`**（文本 ✅ / 图像 ✅ / 函数调用 ✅），本轮全部结果都由它产生。

- 图像能力经标注核对，不是"看起来能读"：中文研报页片段召回 80%、数字召回 100%、编辑距离 0.259。
- 另有一个被测过的候选模型 `deepseek-v4-pro`，实测**不接受图像输入**（返回"无法读取该图片内容"，`prompt_tokens=124`，说明图像未进入上下文）。按项目要求本轮不使用它，该事实仅作为能力边界记录，证据见 `tools/peek-model.js` 与 `probe8`。

**关于"横向对比"**：原计划要求"≥2 个模型的横向对比表"。由于本轮只使用一个模型，该验收项**改为**
「口径 A（直连模型）vs 口径 B（平台链路）」的对比（见第五节）——两者测的是同一条链路上"裸模型"与
"平台自己那套编排"的差别，比换一个模型更能回答"我们平台行不行"。
代码里的多模型路径全部保留（`--models a,b`，以及 FinanceBench「用另一个模型当裁判」的交叉裁判），
将来获批第二个模型即可直接恢复跨模型对比。

## 四、判分器可信度（先验证判分器，再谈成绩）

FinanceBench 仓库公开了论文各模型的逐题作答与判定标签，这让我们能在不调用任何模型的前提下检验自己的判分器：

```
node bench/external/run.js --only financebench --validate-only
```

确定性数值判分与论文标签的一致率（52 道纯数值题）：GPT-4 oracle 90.4%、GPT-4-1106 oracle 90.4%、
Claude-2 82.7%、Llama2-70B 88.5%、GPT-4 closed-book 100%。
**不换算量纲时只有 61.5%**——FinanceBench 的标准答案常写作 `0.4`（十亿美元）或 `0.019`（比率），
而模型写作 `$389 million` / `1.9%`。量纲换算因此写进判分器并记录换算倍率。

结论：确定性判分**只作辅助**，主指标用交叉模型裁判；两者都报，差额本身就是结论的一部分。

## 五、两种口径：直连模型 vs 平台链路

外部基准的题目有两种送法，两者回答的问题不同，报告里必须分开写：

| 口径 | 怎么问 | 回答什么问题 | 命令 |
|---|---|---|---|
| **A 直连模型** | 题目直接发给 `/chat/completions` | 底座模型的能力，用于与外部榜单对话 | `node bench/external/run.js` |
| **B 平台链路** | 题目经平台 `/api/chat/stream`（平台系统提示词 + 25 个工具 + 附件读取） | **平台自己那套链路行不行**，有没有因为提示词或工具编排而损失能力 | `node bench/external/platform-chain.js --cflue 60 --mm 20` |

口径 B 使用与口径 A **同一种子、同一洗牌序列**的题号（因此前者是后者的嵌套子集），
报告里按 id 取交集逐题对比，而不是各跑各的再比总数——后者在方法上不成立。

## 六、怎么跑

```bash
# 0) 抓数据（命中缓存则零网络）+ 许可证核查 + 题库盘点
node bench/external/prepare.js --with-assets

# 1) 出数前的自检：映射、答案、路径必须真的存在
node bench/external/tools/preflight.js

# 2) 只抽样不调用模型，先看题量与批次哈希
node bench/external/run.js --dry

# 3) 小样本打通链路（约 200 次调用）
node bench/external/run.js --small --models deepseek-flash

# 4) 正式出数（全部基准、两个模型）
node bench/external/run.js --concurrency 6

# 单基准 / 单模型 / 不消耗调用的判分器验证
node bench/external/run.js --only bfcl --medium
node bench/external/run.js --only financebench --validate-only
node bench/external/run.js --only omnidocbench --merge   # 只重跑一个基准，保留其余结果

# 5) 平台链路复测（口径 B，会自己起后端并在结束时关掉）
node bench/external/platform-chain.js --cflue 60 --mm 20

# 6) 生成正式报告（Word + Markdown，数字全部来自产物）
python bench/external/report/make-alignment-report.py
```

产物：`reports/external-alignment-v1.json`（聚合，入库）、`reports/external-alignment-v1.md`（人读，入库）、
`out/run-<时间戳>/*.json`（逐题明细，不入库）。

## 六、刻意没做的事

- **不跑 BFCL 的 parallel / multi-turn / exec / live 子集**：需要执行环境与多轮交互，成本与收益不匹配。
- **不跑 FinanceBench 的检索口径**（singleStore/sharedStore）：本轮用仓库自带 evidence 文本，属"给定证据"，
  不测检索能力——报告里已明确，避免把它读成"端到端财报问答能力"。
- **不宣称 FinEval 总分**：经典学术/行业选择题未随仓库公开（`data-v2` 为 .rar，测试集答案不公开），
  我们只跑严谨性与多模态子集。
- **不实现 OmniDocBench 官方指标**（TEDS/CDM/编辑距离为 Python 实现，且需要官方数据管线）：
  只报自实现的片段召回、数字召回、字符编辑距离比与 ROUGE-L，并标注不可与官方榜单直接比大小。
- **不做任何"调提示词直到分数好看"的优化**：所有提示词在报告里公开，成绩是第一次跑出来的结果。

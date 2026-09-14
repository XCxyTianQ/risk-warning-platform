# 外部基准对齐 · v1

- 生成时间：2026-09-14T04:32:08.444Z
- 抽样档位：full；随机种子：20260101；并发：6
- 被测模型：deepseek-flash

> 本文件由 `bench/external/run.js` 自动生成，数字全部来自评测产物；口径与局限见 `bench/external/README.md`。

## CFLUE

- 对应平台层级：模型层：中文金融知识与指令遵循
- 来源：aliyun/cflue@master · [论文](https://aclanthology.org/2024.findings-acl.337/)
- 抽样：{"knowledge":{"available":3864,"picked":300,"hash":"26dabaff8840"},"application":{"available":125,"picked":125,"hash":"cc7f5b346c11"}}
- 说明：知识题 3864 → 抽 300；应用题 125 → 抽 125（25 子任务各 5 条，全量）

| 模型 | 关键指标 | 用时(s) |
|---|---|---:|
| deepseek-flash | knowledge.overall=89.93%(n=298); knowledge.byTaskType.__ALL__=89.93%(n=298); knowledge.byTaskType.判断题=88%(n=25); knowledge.byTaskType.单项选择题=95.29%(n=191); knowledge.byTaskType.多项选择题=78.05%(n=82); knowledge.bySubject.__ALL__=89.93%(n=298); knowledge.bySubject.判断题 / 证券从业资格=100%(n=1) | 355 |

## FinEval 金融严谨性（数值计算 + 指标抽取）

- 对应平台层级：数值严谨性层：从给定检索内容做金融数值计算与指标抽取
- 来源：SUFE-AIFLM-Lab/FinEval@main · [论文](https://aclanthology.org/2025.naacl-long.318.pdf)
- 抽样：{"numerical":{"available":42,"picked":42,"hash":"f25bb69f55cd"},"index":{"available":340,"picked":340,"hash":"7e10d59243e0"}}
- 说明：数值计算 42 → 抽 42（全量 42）
- 说明：指标抽取 340 → 抽 340
- 说明：FinEval 经典学术/行业选择题未随仓库公开（data-v2 为 .rar 且测试集答案不公开），因此这不是 FinEval 总分
- 说明：题目自带的检索内容（基座query）已包含在提示词里，属"给定证据"口径，不测检索能力

| 模型 | 关键指标 | 用时(s) |
|---|---|---:|
| deepseek-flash | numerical.overall=85.71%(n=42); numerical.byGroup.__ALL__=85.71%(n=42); numerical.byGroup.金融严谨性/数值计算=85.71%(n=42); indexExtraction.overall=9.41%(n=340); indexExtraction.bySubject.__ALL__=9.41%(n=340); indexExtraction.bySubject.股票=2.14%(n=187); indexExtraction.bySubject.宏观=2.63%(n=38) | 1032.7 |

## FinEval-MM（财报图表截图四选一）

- 对应平台层级：多模态读取层：从财报/研报图表截图中取数
- 来源：SUFE-AIFLM-Lab/FinEval@main · [论文](https://aclanthology.org/2025.naacl-long.318.pdf)
- 抽样：{"multimodal":{"available":371,"picked":150,"hash":"f368c3a8d37c"}}
- 分布：{"coverage":{"funnel":{"rows":1000,"withImage":1000,"withImageAndAnswer":943,"resolvableImage":464,"usable":371},"missingBySubdir":{"31":2,"32":2,"33":3,"lc":113,"pg":166,"sdt":149,"hg":8,"frg":14,"fs":6,"os":9,"cc":6,"L3Q3_4":1},"totalWithImage":943,"available":371,"coveragePct":39.3},"roundDistribution":{"1":283,"1.0":20,"2.0":21,"3.0":20,"4.0":16,"5.0":8,"6.0":3}}
- 说明：数据可得性漏斗：TSV 总行 1000 → 带图 1000 → 带图且有答案 943 → 图像在仓库中确实存在 464 → 选项≥2 可用 371
- 说明：拿不到图像的目录（按引用次数）：figure/pg×166、figure/sdt×149、figure/lc×113、figure/frg×14、figure/os×9、figure/hg×8、figure/fs×6、figure/cc×6、figure/33×3、figure/31×2、figure/32×2、figure/L3Q3_4×1——仓库未发布、HF 镜像返回 401
- 说明：本项只在可用子集（371 题）上分层抽 150 题；round 字段分布 {"1":283,"1.0":20,"2.0":21,"3.0":20,"4.0":16,"5.0":8,"6.0":3}
- 说明：本轮按单轮提问（不构造多轮上下文）

| 模型 | 关键指标 | 用时(s) |
|---|---|---:|
| deepseek-flash | multimodal.overall=66%(n=150); multimodal.byFintype.__ALL__=66%(n=150); multimodal.byFintype.FinEval-MM/金融市场情绪洞察=60%(n=5); multimodal.byFintype.FinEval-MM/金融情景分析=57.14%(n=14); multimodal.byFintype.FinEval-MM/产业分析推断=100%(n=9); multimodal.byFintype.FinEval-MM/投资分析=85.71%(n=7); multimodal.byFintype.FinEval-MM/股票k线解读=73.33%(n=15) | 216.4 |

## BFCL v4（工具调用：simple / multiple / irrelevance）

- 对应平台层级：工具调用层：平台 25 个工具与 MCP 接入的底座能力
- 来源：ShishirPatil/gorilla@main · [论文](https://gorilla.cs.berkeley.edu/leaderboard.html)
- 抽样：{"simple":{"available":400,"picked":200,"hash":"2c50fe1f1e9c"},"multiple":{"available":200,"picked":200,"hash":"61b4abdd212f"},"irrelevance":{"available":240,"picked":120,"hash":"b60676c6db6a"}}
- 说明：判分为官方 ast_checker.py 的自实现移植（含错误类型分类），不是官方 checker，不得与官方榜单分数直接等同
- 说明：函数 schema 由 BFCL 的 Python 口径（type=dict/float）转换为 JSON Schema 后传入，转换器固定并可复查
- 说明：未测 parallel / multi-turn / exec / live 子集：需要执行环境与多轮交互

| 模型 | 关键指标 | 用时(s) |
|---|---|---:|
| deepseek-flash | overall=87.5%(n=520); byCategory.__ALL__=87.5%(n=520); byCategory.BFCL/simple（单函数）=94.5%(n=200); byCategory.BFCL/multiple（多函数选一）=88.5%(n=200); byCategory.BFCL/irrelevance（应拒调）=74.17%(n=120) | 103.4 |

## OmniDocBench（demo 18 页整页转写）

- 对应平台层级：文档读取层：页面图像 → 结构化文本（中文研报/杂志/报纸等）
- 来源：opendatalab/OmniDocBench@main · [论文](https://arxiv.org/abs/2412.07626)
- 抽样：{"pages":{"available":18,"picked":18,"hash":"4a780eccf8ce"}}
- 分布：{"byLanguage":{"english":7,"simplified_chinese":10,"en_ch_mixed":1}}
- 说明：官方 demo 共 18 页（全集 981 页），本轮全量跑 demo
- 说明：其中含表格的页面 9 页、含公式的 2 页
- 说明：GT 文本 = 标注 text 字段 + 表格 html 去标签 + 公式 latex（表格在标注里没有 text 字段，只取 text 会漏掉表格内容）
- 说明：指标为自实现的片段召回/数字召回/编辑距离比/ROUGE-L，**不是**官方 TEDS/CDM/编辑距离口径
- 说明：中文页面占比见 byLanguage；研报类页面与平台场景最接近

| 模型 | 关键指标 | 用时(s) |
|---|---|---:|
| deepseek-flash | - | 44.7 |

## FinanceBench（开源子集，oracle / closedBook 双口径）

- 对应平台层级：财报文档问答层：有证据时的数值作答与证据引用
- 来源：patronus-ai/financebench@main · [论文](https://arxiv.org/abs/2311.11944)
- 抽样：{"questions":{"available":150,"picked":150,"hash":"b0d4c5e27113"}}
- 分布：{"byType":{"metrics-generated":50,"domain-relevant":50,"novel-generated":50}}
- 说明：口径：oracle（题目自带证据文本）/ closedBook（不给证据）；官方开源子集，非官方全量 10,231 题
- 说明：证据文本来自仓库自带 evidence 字段（原文片段），因此本项不测检索能力，只测"有证据时能否答对"
- 说明：判分：确定性判分（数值容差/包含）+ 交叉模型裁判（用另一个模型判，避免同源偏好），并先用论文标签验证判分器

| 模型 | 关键指标 | 用时(s) |
|---|---|---:|
| deepseek-flash | judgeGraded.byMode.__ALL__=63.33%(n=300); judgeGraded.byMode.oracle=82%(n=150); judgeGraded.byMode.closedBook=44.67%(n=150); deterministic.byMode.oracle=35.33%(n=150); deterministic.byMode.closedBook=19.33%(n=150); byQuestionType.__ALL__=82%(n=150); byQuestionType.FinanceBench/metrics-generated=88%(n=50) | 766.9 |

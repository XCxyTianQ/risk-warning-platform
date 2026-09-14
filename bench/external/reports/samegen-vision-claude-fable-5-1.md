# 外部基准对齐 · v1

- 生成时间：2026-09-14T13:39:19.504Z
- 抽样档位：full；随机种子：20260101；并发：3
- 被测模型：claude-fable-5-1

> 本文件由 `bench/external/run.js` 自动生成，数字全部来自评测产物；口径与局限见 `bench/external/README.md`。

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
| claude-fable-5-1 | multimodal.overall=64.67%(n=150); multimodal.byFintype.__ALL__=64.67%(n=150); multimodal.byFintype.FinEval-MM/金融市场情绪洞察=60%(n=5); multimodal.byFintype.FinEval-MM/金融情景分析=50%(n=14); multimodal.byFintype.FinEval-MM/产业分析推断=100%(n=9); multimodal.byFintype.FinEval-MM/投资分析=100%(n=7); multimodal.byFintype.FinEval-MM/股票k线解读=73.33%(n=15) | 300.7 |

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
| claude-fable-5-1 | - | 166.2 |

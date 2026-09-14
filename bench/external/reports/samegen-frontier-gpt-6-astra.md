# 外部基准对齐 · v1

- 生成时间：2026-09-14T12:58:49.657Z
- 抽样档位：full；随机种子：20260101；并发：5
- 被测模型：gpt-6-astra

> 本文件由 `bench/external/run.js` 自动生成，数字全部来自评测产物；口径与局限见 `bench/external/README.md`。

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
| gpt-6-astra | judgeGraded.byMode.__ALL__=70.67%(n=300); judgeGraded.byMode.oracle=90.67%(n=150); judgeGraded.byMode.closedBook=50.67%(n=150); deterministic.byMode.oracle=34%(n=150); deterministic.byMode.closedBook=19.33%(n=150); byQuestionType.__ALL__=90.67%(n=150); byQuestionType.FinanceBench/metrics-generated=96%(n=50) | 490.7 |

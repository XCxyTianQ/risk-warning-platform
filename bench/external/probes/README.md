# 探测记录（侦查阶段）

这些脚本不是评测的一部分，而是**下结论之前必须先确认的事实**。
按顺序跑一遍，就能回答"这批外部基准到底能不能做"：

| 脚本 | 回答什么问题 | 本轮结论 |
|---|---|---|
| `probe-benchmarks.js` | 12 个候选基准的仓库/数据是否可达 | 可达 8/12；HuggingFace 官方域名不可达（镜像可达），CFBenchmark/FinBen 不可用 |
| `probe2-sources.js` | 题目文件是否随仓库分发；有无镜像回退；模型侧有哪些可用模型 | CFLUE/FinEval/FinanceBench/BFCL/OmniDocBench 的数据都在 GitHub 上；hf-mirror 可作回退 |
| `probe3-inventory.js` | 各仓库到底有哪些数据文件（含体积） | 定位到 CFLUE 两个题集、FinEval 严谨性 CSV、FinanceBench 开源 jsonl 与论文公开结果、BFCL v4 各子集 |
| `probe4-schema.js` | **答案键是否存在**（没有答案就只能交卷不能自评） | CFLUE 3,864 题全部带答案；FinanceBench 150 题带答案+证据+论文标签；BFCL 带 possible_answer |
| `probe5-schema2.js` | FinEval 各文件字段、OmniDocBench 标注字段、BFCL 的 JSONL 结构 | 确认严谨性题自带检索内容；OmniDocBench 的表格内容在 `html` 字段而非 `text` |
| `probe6-model.js` | 文本 / 图像 / 函数调用三条通道是否真的可用 | 三条通道均可用；`deepseek-flash` 与 `deepseek-v4-pro` 的文本与工具调用都正常 |
| `probe7-details.js` | 判分器设计所需的细节（题型、答案形态、阅读顺序字段） | CFLUE 有单选/多选/判断三种题型；OmniDocBench 自带 `order` 阅读顺序 |
| `probe8-vision-verify.js` | **图片到底有没有被读到**（用标注客观核对，而不是"看起来读了"） | flash：片段召回 80%、数字召回 100%、编辑距离 0.259 ✅；v4-pro：拒绝图像，prompt_tokens=124 ❌ |
| `probe9-fineval-mm.js` | FinEval-MM 的图表截图到底发布了多少 | TSV 引用 1,000 行，图像随仓库发布的仅 464 行（可用 371 行）；其余目录仓库未发布、HF 返回 401 |

用法（都需要先跑过 `node bench/external/prepare.js`，部分脚本会自行抓取）：

```bash
node bench/external/probes/probe-benchmarks.js
node bench/external/probes/probe8-vision-verify.js
```

> 这些脚本的输出是"当时那一刻"的观测结果，站点或仓库后续可能变化；
> 报告与 `out/manifest.json` 记录的是实际抓取到的版本与 sha256。

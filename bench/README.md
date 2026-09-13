# rwp-bench —— 统一评测入口（M0）

一句话：**一条命令，把所有验证资产跑一遍，产出可归档、可对比的数字。**

> 注意区分三件事（报告里也是分开的）：
> 1. **回归测试**（探针/冒烟：功能有没有坏）——`probe-*` / `smoke-*` / `verify-grid`；
> 2. **工程指标**（冷启动、接口时延、包体、产物完整性）——平台指标；
> 3. **能力基准**（读得准不准、能不能发现错、算得对不对）——`finrisk-bench`（见下节）。

## FinRisk-Bench（能力基准）

```bash
# 单跑基准（会自己起一个独立后端，用旧库夹具，不污染主库）
node bench/run.js --only finrisk-bench
# 直接跑（已有后端时）
node bench/benchmark/run.js --port 8266 --cases 12 --seed 20260913
```

产物：`bench/report/finrisk-bench.md` / `.json`（另有一行 `FINRISK: {...}` 汇总进入主报告）。

| 层 | 测什么 | 判定方式 | 当前门槛 |
|---|---|---|---|
| **T1 结构化抽取** | 宽表文本 → 平台导入 → 逐格比对 | 真值由生成过程给出（含千分位/括号负数/全角空格/单位行等脏格式） | 字段 F1 ≥ 0.98、完全命中率 ≥ 0.95 |
| **T3 勾稽校验** | 注入 4 类已知缺陷（不平/缺权益/比率不一致/缺期间） | 期望被拦住（导入拒绝或校验报错），干净样本不得误报 | 召回 ≥ 0.95、误报率 ≤ 0.05 |
| **T4 指标正确性** | 合成财报入库 → 与**独立重算**的 KPI 比对 | 资产负债率/毛利率/净利率/ROE/ROA/流动比率/周转率/权益乘数，相对误差 ≤ 0.5% | 一致率 ≥ 0.95 |

**边界（必须说清楚）**：
- v0.1 只覆盖**自动判定层**。`T2 图片读取`、`T5 风险标签与预警`、`T6 Agent 工具链`、`T7 报告质量`尚未纳入——
  T2/T6 需要真实模型与稳定判定规则，**T5 需要真实风险事件标签（属于数据管道工作）**；
- 样本是"合成的真实形状"：满足会计恒等式、带脏格式，但**不能替代真实上市公司财报**；
- 该基准测"读得准、能发现错、算得对"，**不测**"预警是否真有价值"——后者必须靠 T5 与事后事件对齐。

## 用法

```bash
node bench/run.js                      # 全量（本机有界面时含 GUI 冒烟）
node bench/run.js --no-gui             # 只跑探针 + 平台指标（CI 默认）
node bench/run.js --with-reference     # 额外跑金标准比对（Rust vs Python 参考实现）
node bench/run.js --with-llm           # 额外跑需要真实模型的套件（对话/研判/审批/压缩/多模态）
node bench/run.js --with-mcp           # 额外跑 MCP 工具装配（本地 mock MCP，端口 8765）
node bench/run.js --with-llm --with-reference --with-mcp   # 全绿口径（当前：23 套件 / 214 断言）
node bench/run.js --only finrisk-bench # 只跑能力基准
node bench/run.js --update-baseline    # 全绿时把当前数字固化为基线
```

### 真实模型（`--with-llm`）

Key 解析顺序（**不会写进仓库，也不会写进报告**）：

1. 环境变量 `RWP_LLM_API_KEY` / `RWP_LLM_BASE_URL` / `RWP_LLM_MODEL`（CI 用 secret）
2. Key 文件：`RWP_BENCH_KEY_FILE` → `~/Desktop/KEY.txt` → `~/Desktop/KEY-Linux.txt` → `<repo>/KEY.txt`
3. 默认：`https://api.deepseek.com/v1` + `deepseek-flash`（原生多模态），可用 `--llm-model` 覆盖

报告里只记录 `baseUrl / model / Key 来源 / Key 掩码`，例如
`https://api.deepseek.com/v1 · deepseek-flash（Key 来源 C:\Users\...\Desktop\KEY.txt，sk-a39…84cc）`。

> **成本提醒**：`--with-llm` 会产生真实调用。一次全量大约 **40–60 次模型调用 / 约 3 分钟**；
> 评测后端默认关闭启动预热（`RWP_PREHEAT_ON_STARTUP=false`）。CI 默认**不**开 `--with-llm`。

产物：

| 文件 | 用途 |
|---|---|
| `bench/report/bench-report.json` | 机器可读（CI 归档、以后画趋势图） |
| `bench/report/bench-report.md` | 人可读（直接贴汇报/答辩材料） |
| `bench/report/logs/*.log` | 每个套件的完整输出，失败时看这里 |
| `bench/baseline.json` | 上一次"公认良好"的数字，用于发现退化 |

## 它到底测了什么

| 套件 | 覆盖 | 需要 |
|---|---|---|
| `probe-tables` (36) | 表格对象：模板/字段字典/在线创建/三种写入/勾稽拦截/入库/引擎联动/幂等 | - |
| `probe-sheets` (21) | 导入：粘贴 TSV / CSV / XLSX / 长表透视 / 单位识别 / 失败路径 | - |
| `probe-workbook` (19) | 工作簿：空白表默认、自由命名、多表隔离、当前表入库、旧结构归一化 | - |
| `probe-media` (15) | 多模态附件：上传/去重/读取（跳过真实模型步骤） | - |
| `finrisk-bench` | **能力基准**：T1 抽取 F1 / T3 勾稽检出率与误报率 / T4 指标一致率（详见上节） | - |
| `legacy-db-compat` (13) | **旧数据目录兼容**：用 Python 时代 schema 的夹具建库，验证升级后会话/表格/企业建档等写路径仍可用 | - |
| `probe-finance-golden` | **金标准逐点比对**：KPI / 杜邦 / Z·F·M / 异常 / 对标分位（272 项 / 0 差异） | `--with-reference` |
| `probe-datasource-golden` | 数据源刷新结果与 Python 版一致（真实网络，容差 1%） | `--with-reference` + 外网 |
| `probe-chat-golden` | 对话链路（含工具调用）+ 六维评分 Rust vs Python 逐项 | `--with-llm` + `--with-reference` |
| `probe-p4` (50) | 技能/预设/插件/设置/MCP 服务端与会话管理金标准比对 | `--with-reference`（MCP 用例需 `--with-mcp`） |
| `probe-p4-risk` (27) | `run_risk_analysis` 工具 + 按名称研判 + 读侧快照 | `--with-llm` + `--with-reference` |
| `probe-p4-tools` (15) | 内置 + 手搓插件 + MCP 工具是否真的进入模型 tools 数组、预设白名单是否精确生效 | `--with-mcp`（探针自带 mock LLM） |
| `probe-compaction` | 小窗口（4k）+ 4 轮对话**必须真的触发压缩**（断言 `compact_count ≥ 1`） | `--with-llm` |
| `probe-approval` | 写操作授权闭环：SSE 待授权 → 批准 → 工具继续执行 → 数据真的刷新 | `--with-llm` |
| `smoke-backend` | 后端二进制能启动/建库/健康检查 | - |
| `smoke-tables` / `smoke-excel` / `smoke-workbook` / `smoke-import` / `smoke-keep-long` / `verify-grid` / `smoke-finance` | Electron 真实界面链路（栅格编辑、工作簿、导入、透视、真事件回归、金融面板） | 有界面 |
| `smoke-chat` / `smoke-media` | 对话工作区（含附图提问）；图片财报 → 结构化字段 → 写入模板表（标待确认）→ 全部确认 → 可入库 | `--with-llm` + 有界面 |
| 平台指标（内置） | 冷启动中位数、只读接口 p50/p95、前端包体、产物完整性、样例数据灌入 | - |

**跳过 ≠ 通过**：每条跳过都会在报告里写明原因（例如"未开启 `--with-llm`"）。

## 三个设计约定

1. **隔离**：所有套件跑在临时数据目录里（`%TEMP%/rwp-bench-<pid>`），绝不动开发者/队友的真实数据；跑完自动清理（`--keep-data` 可保留）。
2. **两级判定**：
   - `gate`（门禁）：确定性套件，失败 → 整轮判红、CI 失败；
   - `extended`：依赖外网/真实模型/参考实现，失败会列出但**不拦路**（避免把网络抖动当成产品回归）。
   平台指标同样分级：`门禁` 与 `v1 目标`（未达标只记账，不判红）。
3. **可复现**：报告里带 git commit、应用版本、后端二进制 sha256、Node/Python/Rust 版本、随机种子位（M1 起用于抽样），以及当次完整命令。

## 维护工具

```bash
# 旧库升级风险扫描：把"某个旧库的 schema"与"全部 INSERT 语句"对一遍，
# 列出会因 NOT NULL 无默认值而写失败的表（改 schema / 加新表后建议跑一次）
node bench/tools/scan-legacy-inserts.js --db "%APPDATA%\RiskWarningPlatform\data\platform.db"
```

## 加一个套件
在 `bench/suites.js` 里加一条声明即可，不用改运行器：

```js
{
  id: 'probe-xxx',
  title: '一句话说明覆盖什么',
  kind: 'probe',                         // probe | smoke
  bin: 'python',                         // python | python-httpx | node | electron
  args: ['{repo}/backend/tests/probe_xxx.py', '--port', '{port}'],
  parse: 'probe',                        // probe: 解析 "结果：N 通过 / M 失败"；smoke: 解析 ERRORS/SUMMARY
  timeoutMs: 180000,
  requires: [],                          // gui | reference | llm | mcp | image
}
```

可用占位符：`{repo} {port} {dataDir} {webDist} {url} {exe} {python} {electron} {parityPort} {pyDataDir} {pyPort} {goldenDb}`。

**套件本身的写法要求**（踩过的坑）：

- 脚本必须有**自己的超时**（`setTimeout(... app.exit(2))`），否则一次卡死会挂住整个评测；
- 每步 `executeJavaScript` 用 `Promise.race` 加超时，并打印 `STEP_TIMEOUT`（运行器会把 `STEP_TIMEOUT` 判为失败）；
- 别在界面里点会弹原生对话框的按钮（如删除确认）——渲染进程会卡住；用 `fetch` 调接口代替；
- 结束时 `app.exit(0|非0)`，并打印 `SUMMARY: {...}` / `ERRORS: [...]` 便于运行器解析。

## 与 CI 的关系

`.github/workflows/bench.yml` 在每次 push / PR 上跑 `--no-gui`（探针 + 平台指标），把报告写进 Job Summary 并作为 artifact 上传；另有一个**实验性** job 尝试在 CI 里跑 GUI 冒烟（`--with-gui`，`continue-on-error`），用来验证可行性。

## 现状与下一步（M1）

- 已纳入：**23 个套件全部可跑**（`--with-llm --with-reference --with-mcp` 时 23/23 通过、214 条断言）；
  默认无 Key 环境下 15 个确定性套件执行，8 个按开关启用；
- 旧库兼容有专门的夹具与套件（`legacy-db-compat`）：**升级路径必须有测试**，这是踩过 P0 之后定下的规矩
  （旧库 `NOT NULL` 无默认值 → 新建会话/新增企业/生成预警全部失败，详见 `docs/v1-工程重评估与量化指标方案.md` 9.8）；
- 平台指标目前是**本机基线**（空库、5 家样例企业），不是压力测试：数据量放大后要重测并更新门槛；
- 已知 v1 目标未达标项（只记账不判红）：前端仍是单 chunk（1.37 MB raw / 453 KB gzip）；
- M1 起补：业务指标基准（`FinRisk-Bench` 的 T1/T3/T4 自动层）、外部基准抽样、报告趋势图。

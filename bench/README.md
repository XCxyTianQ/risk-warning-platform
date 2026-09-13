# rwp-bench —— 统一评测入口（M0）

一句话：**一条命令，把所有验证资产跑一遍，产出可归档、可对比的数字。**

```bash
node bench/run.js                      # 全量（本机有界面时含 GUI 冒烟）
node bench/run.js --no-gui             # 只跑探针 + 平台指标（CI 默认）
node bench/run.js --with-reference     # 额外跑金标准比对（Rust vs Python 参考实现）
node bench/run.js --update-baseline    # 全绿时把当前数字固化为基线
```

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
| `probe-finance-golden` | **金标准逐点比对**：KPI / 杜邦 / Z·F·M / 异常 / 对标分位（报告里直接给"比对 N 项、差异 M 处"） | `--with-reference` |
| `probe-datasource-golden` | 数据源刷新结果与 Python 版一致（真实网络，容差 1%） | `--with-reference` + 外网 |
| `smoke-backend` | 后端二进制能启动/建库/健康检查 | - |
| `smoke-tables` / `smoke-excel` / `smoke-workbook` / `smoke-import` / `smoke-keep-long` / `verify-grid` / `smoke-finance` | Electron 真实界面链路（栅格编辑、工作簿、导入、透视、真事件回归） | 有界面 |
| `probe-chat-golden` / `probe-p4*` / `probe-compaction` / `probe-approval` / `smoke-chat` / `smoke-media` | 对话/研判/压缩/审批/多模态识别链路 | `--with-llm` + 真实模型配额 |
| 平台指标（内置） | 冷启动中位数、只读接口 p50/p95、前端包体、产物完整性、样例数据灌入 | - |

**跳过 ≠ 通过**：每条跳过都会在报告里写明原因（例如"未开启 `--with-llm`"）。

## 三个设计约定

1. **隔离**：所有套件跑在临时数据目录里（`%TEMP%/rwp-bench-<pid>`），绝不动开发者/队友的真实数据；跑完自动清理（`--keep-data` 可保留）。
2. **两级判定**：
   - `gate`（门禁）：确定性套件，失败 → 整轮判红、CI 失败；
   - `extended`：依赖外网/真实模型/参考实现，失败会列出但**不拦路**（避免把网络抖动当成产品回归）。
   平台指标同样分级：`门禁` 与 `v1 目标`（未达标只记账，不判红）。
3. **可复现**：报告里带 git commit、应用版本、后端二进制 sha256、Node/Python/Rust 版本、随机种子位（M1 起用于抽样），以及当次完整命令。

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

- 已纳入：14 个套件（107 条断言）默认执行，8 个需模型/参考环境的套件按开关启用；
- 平台指标目前是**本机基线**（空库、5 家样例企业），不是压力测试：数据量放大后要重测并更新门槛；
- M1 起补：业务指标基准（`FinRisk-Bench` 的 T1/T3/T4 自动层）、外部基准抽样、报告趋势图。

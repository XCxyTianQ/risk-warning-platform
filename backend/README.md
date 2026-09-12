# 后端（Rust 重写版）

用 Rust 重写「企业经营风险预警平台」后端，替代 `server/`（Python，7,875 行）。
目标：单静态二进制、无解释器依赖、四平台可交叉编译，从根上消除
"Python 版本差异 / PyInstaller 打包 / 架构匹配" 这类兼容问题。

**API 契约、数据库表结构、数据目录约定与原 Python 版保持一致** —— 前端与 Electron 无需改动，
只需把拉起后端的命令换成本二进制。

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 骨架：配置、SQLite（含建表与样例灌入）、health、企业档案、静态托管 + SPA 回落 | ✅ 完成 |
| P1 | LLM 客户端（SSE 流式 / 工具调用 / 用量与耗时）、会话与压缩、六维规则评分、Agent 循环、8 个内置工具、对话与会话 API、总览 API | ✅ 完成 |
| P2 | 数据源直连（新浪财务/三表、东财公告、巨潮诉讼、东财按需代码解析）、幂等入库与 data_status、企业添加/刷新 API、预警生成与处置闭环与报告、写操作授权 | ✅ 完成 |
| P3 | 金融分析引擎（KPI / 杜邦 / Altman Z''、Piotroski F、Beneish M / 同业对标 / 异常勾稽 + Markdown 报告）+ 3 个金融工具 | ✅ 完成 |
| P4 | 技能库与 Agent 预设、手搓插件（声明式 HTTP 工具）、MCP 双向、设置面板后端（DB 覆盖热生效）、会话导出/导入/分享、`run_risk_analysis`（LLM 研判）+ 风险事实接口 | ✅ 完成 |
| P5 | 桌面端切换到 Rust 二进制、CI 三平台构建、发布 v0.5.0 | ✅ 完成 |
| P6 | **表格对象**（在线创建/编辑/撤销 + 勾稽校验 + 入库联动）与**多模态输入/读取**（附件、Reading、图片识别填表、CSV·XLSX·TSV 确定性导入） | ✅ 完成 |

### P6 实测结论（表格对象与多模态）

三组探针 + 两个 UI 冒烟，共 **89 项断言全部通过**：

| 验证 | 覆盖 | 结果 |
|---|---|---|
| `probe_rust_tables.py` | 模板与字段字典（37 个引擎字段带别名）、在线创建、单格/按行/区域写入、勾稽拦截（BALANCE_MISMATCH 阻止入库）与修正通过、入库预览与入库、引擎联动（无财报企业录入后金融分析可用、KPI 等于录入值、六维 finance 可评分）、幂等更新、公开数据不被覆盖、6 个表格工具注册 | **36 项** |
| `probe_rust_media.py` | 三种上传入口、sha256 内容寻址去重、类型/大小校验、原始字节预览、视觉读取（结构化字段 + meta + usage + 落库）、识图填表（vision 单元格）、**未确认阻止入库**（VISION_UNCONFIRMED）与确认后通过、对话 SSE attachment 事件与媒体 token、后续轮次历史文本化、删除与引用计数 | **32 项** |
| `probe_rust_sheets.py` | 粘贴 TSV 建表、宽表/长表识别与透视、CSV 上传（单位自动识别）、XLSX 上传（calamine）、数值容错（千分位/括号负数/%）、确定性单元格 source=file/1.0、失败路径 400 | **21 项** |
| `desktop/scripts/smoke-tables.js` | 面板打开 → 新建并绑定企业 → 录入 → 勾稽报错 → 修正 → 入库 → 状态变「已入库」 | Electron 全流程 |
| `desktop/scripts/smoke-media.js` | 对话粘贴图片（前端压缩）→ chip → 发送 → 用户气泡缩略图 → 模型自动 `list_attachments` + `read_attachment` 作答；表格「从图片识别」（CDP 真实选文件）→ 识别 4 个科目并映射 → 3 格待确认 → 拦截 → 确认后可入库 | Electron 全流程 |
| `desktop/scripts/smoke-import.js` | 粘贴 TSV 建表 → 表格渲染 6 科目 → 改值 → 撤销还原 → 校验通过 → 入库 | Electron 全流程 |

设计要点（这三条决定了功能是否可用）：

1. **表格是一等对象，不是附件**：上传/截图/粘贴只是它的三种"填充方式"；
   `status: draft → confirmed → ingested`，入库后 `finance` 数据带「用户提供」溯源并参与六维评分与金融分析。
2. **读取分两种可信度**：视觉识别（`source=vision`，**未确认不得入库**）与确定性解析
   （`source=file`，可信度 1.0，免确认）；勾稽校验（资产=负债+权益、资产负债率一致性等）
   对两者一视同仁 —— 平台对"数据"也做风险控制。
3. **当期多模态、历史文本化**：只有最新一轮把图片展开成 `image_url` parts，
   历史轮次自动降级为 Reading 文本投影；图片 token 按分辨率档位单独计入压缩估算。


### P4 实测结论（金标准比对）

四组探针，共 **148 项断言全部通过**（`backend/tests/probe_rust_p4*.py`）：

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `probe_rust_p4.py`（金标准库 8240 vs Python 8001） | 技能库、预设、插件、设置元数据与 providers、MCP 服务列表、风险事实、MCP 双向、会话读取/导出/用量 | **55 项 0 差异** |
| 同上（空库 8242 vs Python 8003） | 内置 5 技能 + 4 预设播种内容、设置分组/键/标签/类型、providers、MCP 空态 | **43 项 0 差异** |
| `probe_rust_p4_tools.py`（回显型 mock LLM） | 工具装配：内置 17 + 插件 `custom_*` + MCP `mcp_{id}_{name}` 全部进入模型 tools；预设白名单精确过滤（含 `list_skills/load_skill` 恒保留）与提示词注入；设置热生效切模型 | **15 项 0 差异** |
| `probe_rust_p4_risk.py --with-agent` | `analyze_by_name` 研判、规则侧与 Python 逐项一致、读侧快照、风险事实、对话内 `run_risk_analysis`（授权→执行→回注） | **35 项 0 差异** |

关键一致性细节：

- 会话 **Markdown 导出逐字节一致**（3,040 字符），JSON 导出结构一致，`/api/chat/sessions/{id}` 的
  messages/usage 逐字段一致，`/api/chat/usage` 全局统计一致；
- 时间戳统一为 SQLAlchemy 落库形态（`YYYY-MM-DD HH:MM:SS.ffffff`），读侧转 ISO（`T` 分隔），
  与 Python `.isoformat()` 输出同形 —— 两个后端共用一个库文件时不会出现格式混存；
- MCP 双向：本平台作为 MCP **服务器**（`POST /api/mcp` 的 initialize/tools/list/tools/call 与 Python
  返回的 17 个工具集合、调用结果完全一致），同时作为 MCP **客户端**接入外部服务（mock-mcp 的
  `echo`/`company_lookup` 同步后可被模型调用）；
- 设置保存写 `app_setting` 并立即覆盖内存运行时配置，无需重启；切换模型/端点后自动后台预热前缀。

回归：P1 对话探针（3 次工具调用 / 4.2s / 缓存命中 94%）、P2 授权路径（approval×1 → 工具执行成功）、
P3 金融引擎（272 比对项 0 差异）在同一构建上全部复跑通过。

### P3 实测结论（金标准比对）

对 4 家企业（康美药业 / 贵州茅台 / 宁德时代 / 章源钨业）逐项比对 Rust 与 Python 的
`/api/finance/{id}/analysis`：**272 个比对项，0 处差异**。

| 比对项 | 结果 |
|---|---|
| 16 项 KPI 的值与趋势方向 | 一致 |
| 杜邦分解（ROE / 净利率 / 周转率 / 权益乘数，逐期） | 一致 |
| Altman Z 与 Z''（分数 + 区间判定） | 一致（如康美 Z''=-3.991 困境区、茅台 14.85 安全区、宁德 3.407 安全区） |
| Piotroski F-Score（分数 + 上限） | 一致（康美 9/9、茅台 5/9、宁德 6/9） |
| Beneish M-Score | 一致（康美 -2.552、茅台 -2.888、宁德 -2.714） |
| 异常勾稽（触发项集合） | 一致（康美 LOW_DEDUCTED、茅台 MARGIN_ABOVE_PEERS） |
| 同业对标分位 | 一致 |

报告接口 `/api/finance/{id}/report` 输出 2,475 字符 Markdown（KPI 表 / 杜邦表 / 模型结论 /
异常 / 对标表 / 数据质量说明）；对话中 `get_financial_analysis` 端到端可用，
工具结果超长时给出合法 JSON 截断说明，模型会自行改用 `include_peers=false` 重取。

### P2 实测结论（真实网络）

| 维度 | 结果 |
|---|---|
| finance | 新浪关键指标 + 三表，5 期；`revenue/net_profit/debt_ratio` 与 Python 版**逐字段完全一致** |
| news | 东财公告 30 条/次；库内总数与 Python 版一致（52 条） |
| legal | 巨潮诉讼统计（AES 动态 Enckey）可拉取入库 |
| 代码解析 | 按需查询：`600518 → 康美药业`、`康美药业 → 600518`、`SH600519 → 贵州茅台`（不再批量拉全市场，避免限流） |
| 预警 | 生成结果与 Python 版完全一致（9 家企业，新建 0 / 跳过 19；工单 22 条 red 8 / orange 6 / yellow 8） |
| 报告与处置 | Markdown 报告 200；`start/resolve/ignore/reopen` 流转正常 |

### 迁移中发现并规避的接口陷阱

| 现象 | 原因 | 处理 |
|---|---|---|
| `push2.eastmoney.com` 连接被提前关闭 | 主域限流 | 多镜像回退（`1.push2` / `push2delay` / `82.push2`），并对所有请求加退避重试 |
| 巨潮返回 0 条 | 返回的是对象数组（`AINTERVAL/F001N/F002N/SECCODE`），此前按数组解析 | 按对象字段解析并按 `SECCODE` 过滤 |
| 代码表批量拉取被限流 | 6000 行分页请求过大 | 改为按需查询（单只行情 + 搜索建议），结果进进程内缓存 |
| 东财搜索 JSONP 接口返回空 | 反爬 | 舆情改用可用的公告接口（`np-anotice-stock`） |

## 构建与运行

```bash
cd backend
cargo build --release          # 产物：target/release/risk-warning-backend[.exe]

# 本地运行（端口 0 = 自动分配，stdout 打印 RWP_PORT=<port> 供 Electron 读取）
cargo run -- --port 0 --data-dir ../data --web-dist ../web/dist
```

配置（环境变量，均带 `RWP_` 前缀）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `RWP_DATA_DIR` | 数据目录（SQLite 落在 `<dir>/platform.db`） | `<repo>/data` |
| `RWP_WEB_DIST` | 前端构建产物目录 | `<repo>/web/dist` |
| `RWP_SAMPLES_DIR` | 首次运行灌入的样例数据 | `<repo>/data/samples` |
| `RWP_LLM_BASE_URL` / `RWP_LLM_API_KEY` / `RWP_LLM_MODEL` | 模型服务三参数（可被设置面板的 DB 覆盖） | 本地 mock |
| `RWP_LLM_ANALYSIS_MAX_TOKENS` / `RWP_LLM_DISABLE_THINKING` | 研判输出上限 / 关闭思考 | 8192 / false |
| `RWP_LLM_CONTEXT_WINDOW` / `RWP_COMPACTION_*` | 上下文压缩参数 | 128000 / 0.8 / 0.16 |
| `RWP_PREHEAT_ENABLED` / `RWP_PREHEAT_ON_STARTUP` / `RWP_PREHEAT_TTL_SECONDS` | 提示词缓存预热 | true / true / 600 |
| `RWP_AGENT_REQUIRE_APPROVAL` / `RWP_AGENT_APPROVAL_TIMEOUT` | 动作工具授权 | true / 300 |

设置面板保存的值写入 `app_setting` 表并在启动时覆盖上述默认值（敏感字段只回显掩码）。

## 验证

```bash
# 1) 端到端对话（真实模型 + 工具调用）与金标准比对
python backend/tests/probe_rust_chat.py --rust-port 8232 --py-port 8001

# 2) 强制压缩（窗口压到 3000 触发 compaction，检查跨轮连贯性）
RWP_LLM_CONTEXT_WINDOW=3000 RWP_COMPACTION_THRESHOLD_RATIO=0.5 \
  cargo run -- --port 8233 --data-dir <tmp>
python backend/tests/probe_rust_compaction.py --port 8233 --turns 4

# 3) 金融分析引擎金标准（272 比对项）
python backend/tests/probe_rust_finance.py --rust-port 8238 --py-port 8001

# 4) P4：技能/预设/插件/设置/MCP/会话导出（parity，建议把写侧闭环指向独立实例）
python backend/tests/probe_rust_p4.py --rust-port 8240 --py-port 8001 --write-port 8241

# 5) P4：工具装配（回显型 mock LLM 自证 tools 数组内容）
python backend/tests/probe_rust_p4_tools.py --port 8240

# 6) P4：研判与对话内 run_risk_analysis（需真实模型）
python backend/tests/probe_rust_p4_risk.py --rust-port 8240 --py-port 8001 --with-agent

# 7) P6：表格对象（在线创建/编辑/校验/入库）
python backend/tests/probe_rust_tables.py --port 8250

# 8) P6：多模态输入与读取（上传/去重/视觉读取/识图填表/对话附图，需真实模型）
python backend/tests/probe_rust_media.py --port 8253

# 9) P6：确定性导入（CSV/XLSX/粘贴 TSV，无需模型）
python backend/tests/probe_rust_sheets.py --port 8257
```

**金标准比对方法**：把 Python 版正在使用的数据库复制一份给 Rust 版使用
（`--data-dir` 指向副本），再对比两边端点：企业综合分与六维分、金融引擎 272 项、
技能/预设/插件/设置元数据、会话列表与导出文本必须逐项一致。已验证 9 家企业全部一致。

> 注意：写侧闭环（新建/删除会话、保存设置）会改动库内容，比对时用 `--write-port` 指向
> 另一个独立实例，避免污染 parity 实例；`PUT /api/settings` 会落库，探针不应修改
> `llm_api_key`（GET 只回显掩码，无法还原明文）。

## 已修复的实测问题（Rust 侧）

| 现象 | 原因 | 处理 |
|---|---|---|
| 第二次模型调用挂起 60s 后报 `error decoding response body` | 复用上一轮流式请求的空闲连接 | `pool_max_idle_per_host(0)`，不复用空闲连接 |
| 流式结束后仍等待 | 服务端可能保持连接 | 收到 `[DONE]` 立即停止读取并丢弃响应 |
| 同一会话时间在 Rust 侧 `2026-09-08 12:09`、Python 侧 `2026-09-08T12:09` | SQLAlchemy `DateTime` 落库为空格分隔文本，Python 读侧 `.isoformat()` 转 `T`，Rust 直接回传原串 | 统一 `util::now_db()` 落库、`util::db_to_iso()` 读侧转换（会话/预警/事实/技能/MCP 共 10 处读点） |

## 目录结构

```
backend/src/
  main.rs            入口：参数解析、建库、设置覆盖、内置技能/预设播种、绑定端口、打印 RWP_PORT
  config.rs          启动期配置 + RuntimeCfg（设置面板可热改的子集）
  state.rs           共享状态（Db + Config + RuntimeCfg(RwLock) + 预热器）
  error.rs           统一错误 → HTTP 状态码 + 可读消息
  util.rs            股票代码归一、时间格式（落库形态 ↔ ISO 形态）
  db/{mod,schema,seed}.rs   SQLite 连接、建表、样例灌入
  llm/
    mod.rs           LLM 客户端（流式、工具调用、用量、耗时、重试）
    preheat.rs       提示词前缀缓存预热（TTL 内不重复，本地 mock 跳过）
  agent/
    prompt.rs        system 提示词（静态 → 前缀缓存友好）
    session.rs       会话存储、上下文构建（工具成对性修正）、压缩、导出/导入/分享、用量
    tools.rs         工具注册表 + 内置工具 + 插件/MCP 动态装配 + 预设白名单过滤
    runner.rs        Agent 循环 + SSE 事件 + 授权闸门
    approvals.rs     动作工具授权（等待/决策/超时）
    events.rs        事件 → SSE 序列化
  services/
    rules.rs         六维评分引擎（与 Python 逐条对齐）
    finance.rs       金融分析引擎（KPI / 杜邦 / Z·F·M / 对标 / 异常）
    alerts.rs        预警生成、处置流转、报告
    enterprise.rs    企业档案、股票代码解析、建档
    risk.rs          LLM 研判 + 风险事实 + 读侧快照
    tables.rs        表格对象：模板/字段字典/映射/勾稽校验/入库/确认
    sheet_import.rs  确定性读取：CSV·XLSX 解析、宽表/长表识别、透视、元数据识别
    attachments.rs   多模态输入：内容寻址落盘、去重、Reading 形态与文本投影
    reading.rs       多模态读取：视觉抽取 → 归一化 Reading → 填入表格
    skills.rs        技能库（内置 5 条 + CRUD）
    presets.rs       手搓插件（声明式 HTTP）+ Agent 预设 + 分享包导入导出
    mcp.rs           MCP 客户端（JSON-RPC）与服务管理
    settings.rs      设置元数据、DB 覆盖热生效、模型列表拉取
  api/{mod,chat,dashboard,enterprises,finance,alerts,tables,attachments,skills,plugins,mcp,settings,share}.rs
```

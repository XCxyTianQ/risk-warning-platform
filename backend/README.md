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
| P2 | 数据源直连（新浪财务/三表、东财公告、巨潮诉讼、东财按需代码解析）、幂等入库与 data_status、企业添加/刷新 API、预警生成与处置闭环与报告 | ✅ 主体完成（写操作授权工具待接） |
| P3 | 金融分析引擎（KPI / 杜邦 / Altman Z'' 、Piotroski F、Beneish M / 同业对标 / 异常勾稽）+ 报告 | 待做 |
| P4 | 技能与预设内置数据、MCP 双向、设置面板后端、会话导出与分享、写操作授权（approvals + 3 个写工具） | 待做 |
| P5 | 桌面端切换到 Rust 二进制、CI 四平台构建、发布 v0.5.0 | 待做 |

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
| `RWP_LLM_BASE_URL` / `RWP_LLM_API_KEY` / `RWP_LLM_MODEL` | 模型服务三参数 | 本地 mock |
| `RWP_LLM_CONTEXT_WINDOW` / `RWP_COMPACTION_*` | 上下文压缩参数 | 128000 / 0.8 / 0.16 |

## 验证

```bash
# 1) 端到端对话（真实模型 + 工具调用）与金标准比对
python backend/tests/probe_rust_chat.py --rust-port 8232 --py-port 8001

# 2) 强制压缩（窗口压到 3000 触发 compaction，检查跨轮连贯性）
RWP_LLM_CONTEXT_WINDOW=3000 RWP_COMPACTION_THRESHOLD_RATIO=0.5 \
  cargo run -- --port 8233 --data-dir <tmp>
python backend/tests/probe_rust_compaction.py --port 8233 --turns 4
```

**金标准比对方法**：把 Python 版正在使用的数据库复制一份给 Rust 版使用
（`--data-dir` 指向副本），再对比两边的 `/api/dashboard/summary`：
企业综合分与六维分必须逐项一致。已验证 9 家企业全部一致。

## 已修复的实测问题（Rust 侧）

| 现象 | 原因 | 处理 |
|---|---|---|
| 第二次模型调用挂起 60s 后报 `error decoding response body` | 复用上一轮流式请求的空闲连接 | `pool_max_idle_per_host(0)`，不复用空闲连接 |
| 流式结束后仍等待 | 服务端可能保持连接 | 收到 `[DONE]` 立即停止读取并丢弃响应 |

## 目录结构

```
backend/src/
  main.rs            入口：参数解析、建库、绑定端口、打印 RWP_PORT
  config.rs          配置（CLI + 环境变量）
  state.rs           共享状态（Db + Config）
  error.rs           统一错误 → HTTP 500 + 可读消息
  db/{mod,schema,seed}.rs   SQLite 连接、建表、样例灌入
  llm/mod.rs         LLM 客户端（流式、工具调用、用量、耗时、重试）
  agent/
    prompt.rs        system 提示词（静态 → 前缀缓存友好）
    session.rs       会话存储、上下文构建（工具成对性修正）、压缩
    tools.rs         工具注册表 + 内置工具
    runner.rs        Agent 循环 + SSE 事件
    events.rs        事件 → SSE 序列化
  services/rules.rs  六维评分引擎（与 Python 逐条对齐）
  api/{mod,chat,dashboard,enterprises}.rs   路由
```

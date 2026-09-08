# reasonmc 可复用部分调研报告

> 调查对象：`XCxyTianQ/reasonmc`（LLM 驱动的 Minecraft AI NPC 插件）
> 调查目的：为 risk-warning-platform 的「大模型接入层」提供可直接平移的实现范式
> 结论：无风控业务代码可抄；但 **LLM 网关 / Agent 循环 / 记忆与证据 / 工具注册 / Mock 测试** 五个部件与我们的 `llm/` 层一一对应，设计可直接照搬。

## 一、文件清单与映射

| reasonmc 文件 | 行数 | 机制摘要 | 本项目对应 | 借用方式 |
|---|---|---|---|---|
| `llm/LlmClient.java` | 161 | OpenAI 兼容 chat/completions + function calling，零第三方依赖，配置热生效，usage 统计 | `app/llm/client.py` | **改写为 Python**（结构照搬，改 HTTP 层） |
| `llm/AgentLoop.java` | 224 | Agent 循环 + 工具执行 + 重试退避 + 恒定上下文 | `app/llm/agent.py` | 架构照搬（业务动作换成风险工具） |
| `llm/MemoryExtractor.java` | 83 | 增量提取"新事实/更新"，只输出新增，`<memories>` 标签 | `app/llm/memory.py`（步骤2） | 设计照搬，用于企业信号事实库 |
| `llm/MemoryStore.java` | 145 | 事实列表（text+ts），去重刷新，上限200条/200字，原子写盘 | `app/llm/memory.py` | 设计照搬（JSON→SQLite/PostgreSQL） |
| `mcp/McpTools.java` | — | 工具注册表：definitions/llmTools/call 分发 | `app/llm/tools.py` | 接口照搬 |
| `cli/mock_llm.py` | 113 | OpenAI 兼容 mock 服务，确定性回复，无需 Key | `tests/mock_llm.py` | **几乎直接使用**（改关键词场景） |
| `cli/mock_server.py` | 291 | MCP 协议 mock（JSON-RPC，后台任务 + 轮询） | 暂不需要 | 记录备用 |
| `Conversation.java` | — | 会话窗口（system + 最近 N 轮） | `app/llm/agent.py` 内 | 设计照搬 |

## 二、五个部件的关键设计（照搬要点）

### 1. LlmClient —— LLM 网关
- 三参数 `base_url / api_key / model` 从配置读取（需求 15：多供应商切换成本最小化）
- **调用前先检查 HTTP 状态码再解析 body**：非 2xx 响应体可能是 HTML/空（404 网关页），直接抛可读错误，避免无意义的 JSON 解析异常
- 解析防御链：body 为 null → `error` 字段 → `choices` 空 → 才取 `message`
- 错误分档 `LlmException(statusCode)`：
  - `-1` = 网络/IO/中断；`0` = 响应异常；其它 = HTTP 码
  - `retryable()` = `-1 || 408 || 429 || >=500`；4xx 请求错误（schema/鉴权）不可重试
- 记录 `usage.prompt_tokens` → 供上下文压缩触发判断

### 2. AgentLoop —— 工具调用循环
- 单轮流程：`user → LLM(带tools) → tool_calls → 逐个执行工具 → 结果回注 → 再次调用 → 直到纯文本回复`
- `maxTurns`（默认 8）上限；超界返回提示，不死循环
- `chatWithRetry`：指数退避 500ms→1s；只重试 `retryable()` 错误
- 工具执行异常 → 以 `ERROR: ...` 文本回注，**不中断循环**（模型可决定下一步）
- 上下文恒定：`system_prompt + [长期记忆块] + 最近 N 轮窗口`，不会随会话膨胀
- system prompt 每轮前从配置刷新（热更新生效）

### 3. MemoryExtractor / MemoryStore —— 记忆与证据
- 提取 prompt 规则：**只输出新增事实或旧事实的更新**，不重复已有记忆；无新事实输出空 `<memories>` 标签
- 增量提取（不是每次重新总结），上下文体积恒定
- 事实去重（按文本，已存在则刷新 ts）；上限 200 条、单条 200 字，超限裁最旧
- **原子写盘**（临时文件 + ATOMIC_MOVE，降级 REPLACE_EXISTING）：崩溃遗留要么旧态要么新态
- 加载失败 → 空记忆，不阻塞主流程（fail-open）
- 注入上下文：按 ts 新→旧渲染为 `"- 事实"` 列表

### 4. McpTools —— 工具注册表
- `definitions()`：OpenAI function 格式 schema 集中管理
- `llmTools()`：请求时随 body 发送的 tools 数组
- `call(name, args)`：按名分发执行，白名单控制（防 prompt 注入调用敏感工具）

### 5. mock_llm.py —— 离线模拟器
- OpenAI 兼容：`POST /v1/chat/completions`，返回标准 `choices[0].message` + usage
- **确定性行为**：最后一条消息是 tool → 纯文本回复（总结）；user 含关键词 → 返回指定 `tool_calls`；其他 → 复述
- 用途：开发期不烧钱、不依赖网络，先跑通全链路；评测与功能测试都能复用

## 三、与本项目差异点（改造清单）

| 差异 | reasonmc | 本项目 |
|---|---|---|
| 语言/运行时 | Java 25 + JDK HttpClient + Gson | Python 3.14 + httpx（异步可用） |
| 触发方式 | 聊天事件（AsyncChatEvent） | FastAPI API 请求 / 定时任务 |
| 长期记忆 | NPC 记忆（JSON 文件） | 企业风险信号事实库（DB 表） |
| 工具集 | 世界状态/命令/寻路 | 查财务 / 查涉诉 / 查舆情 / 查规则 |
| 会话窗口 | 短会话（玩家对话） | 单企业单轮研判（窗口 1 轮即可） |

## 四、采纳计划

1. **立即（骨架期）**：`tests/mock_llm.py` 照搬改造；`llm/client.py` 按 LlmClient 设计建骨架（异常分档、配置三参数、解析防御链的函数签名）
2. **步骤 2**：实现 `client.chat()` + `tools.py` 注册表 + `memory.py`（先 JSON 文件版）
3. **步骤 4**：实现 `agent.py` 研判循环（工具=查数/查规则），接预警引擎与台账

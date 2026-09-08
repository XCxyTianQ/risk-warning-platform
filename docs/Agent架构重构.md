# Agent 化架构重构方案（对话式研判）

> 参考 DeepSeek Harness / Codex 的设计哲学，但**不照抄**：把「Agent 循环 + 工具 + 会话 + 流式事件」作为产品核心，
> 现有页面从"主入口"降级为"工具结果的可视化视图"。

## 1. 设计哲学对齐（概念映射）

| Harness / Codex 概念 | 本项目落地 | 说明 |
|---|---|---|
| Agent Loop（模型↔工具循环） | `agent/loop.py` | 用户提问 → 模型决策 → 调工具 → 回注 → 再决策，直到给出回答 |
| Tools as capabilities | `agent/tools.py` | 工具是唯一的数据/动作入口，模型只能通过工具"看"和"做" |
| Session / Thread | `agent/session.py` | 会话保存消息历史，支持多轮追问（"那它的舆情呢？"） |
| Streaming events | SSE `/api/chat/stream` | token / tool / tool_result / done 事件流，前端逐字渲染 |
| Event log & observability | 会话事件列表 + `ingest_log` | 每一步可回放，答辩可展示"模型怎么想的" |
| Provider-agnostic model layer | `llm/client.py`（已有） | OpenAI 兼容三参数，mock/DeepSeek/vLLM 可换 |
| Prompt composition | `agent/prompt.py` | system 提示 + 工具说明 + 输出规范分层拼装 |
| Read-only vs Action tools | 工具标注 `read_only` | 只读工具直接执行；动作工具（触发研判/写库）前端显式提示 |
| 记忆/上下文控制 | `llm/memory.py` + 会话窗口 | 上下文恒定，不随对话膨胀 |

## 2. 目标数据流

```
用户消息
  → /api/chat/stream (SSE)
  → AgentLoop:
       LLM(带 tools) ──tool_calls──▶ 工具执行（查库/评分/触发研判）
            ▲                              │
            └──── tool_result 回注 ◀────────┘
       LLM 生成最终回答（流式 token）
  → 前端：聊天气泡 + 工具调用卡片（可展开看参数/结果）
```

## 3. 新增/调整的模块

```
server/app/
├── agent/                  ★新增：Agent 内核
│   ├── prompt.py           system 提示（角色/工具规则/输出规范）
│   ├── tools.py            工具注册表（读库/评分/研判/对比）
│   ├── session.py          会话与消息历史（内存版；阶段4 落库）
│   ├── events.py           事件类型（token/tool/tool_result/done/error）
│   └── loop.py             Agent 循环（流式，含工具回注与错误兜底）
├── api/chat.py             ★新增：SSE 流式对话接口 + 会话管理
├── llm/client.py           扩展：chat_stream()（SSE 增量解析）
└── services/*, db/*, llm/* 复用（评分/研判/数据访问不变）
```

前端：`views/ChatView.vue`（Copilot 风格对话面板，流式渲染 + 工具卡片 + 建议问题），侧边栏新增「智能问答」。

## 4. 工具清单（阶段3 首批）

| 工具 | 类型 | 作用 |
|---|---|---|
| `search_enterprise(keyword)` | 只读 | 按名称/行业模糊搜索企业 |
| `get_score_profile(enterprise_id)` | 只读 | 六维评分 + 综合评分/评级 |
| `get_risk_facts(enterprise_id, dimension?)` | 只读 | 风险事实与证据（可追溯来源） |
| `list_enterprises_by_level(level)` | 只读 | 按风险等级列企业 |
| `get_platform_overview()` | 只读 | 全平台统计（企业数/等级分布/平均分） |
| `run_risk_analysis(enterprise_id)` | **动作** | 触发一次完整研判（大模型 + 规则校验），耗时 10~40s |

> 工具是唯一入口：模型不能直接读数据库，所有数据都经过工具返回，天然可审计、可加权限。

## 5. 实施步骤

| 步骤 | 内容 | 验收 |
|---|---|---|
| A1 | `llm/client.chat_stream()` + SSE 解析 | 能流式收到 DeepSeek token |
| A2 | `agent/` 内核 + 6 个工具 + `/api/chat/stream` | curl 可见 token/tool/done 事件 |
| A3 | 前端对话面板（流式 + 工具卡片 + 建议问题） | 页面提问"康美药业风险如何"→ 自动调工具并回答 | ✅ |
| A4 | 会话持久化（DB）+ 布局持久化（localStorage） | 刷新后对话历史与面板编排均恢复 | ✅ |
| A5 | 动作工具二次确认（run_risk_analysis / refresh_enterprise_data 前询问用户） | 动作类工具执行前弹出确认 | ✅ |

## 6. MCP 与技能模块（Harness 生态对齐）

### MCP（双向）

| 方向 | 实现 | 说明 |
|---|---|---|
| **接入外部 MCP 服务** | `app/mcp/client.py` + `service.py` + `/api/mcp/servers` | HTTP JSON-RPC 2.0（initialize / ping / tools/list / tools/call）；注册后自动同步工具，Agent 每轮动态加载（工具名 `mcp_<服务id>_<工具名>`，描述带 `[MCP:服务名]` 前缀） |
| **对外暴露本平台** | `POST /api/mcp` | 其他 Agent/客户端可把本平台当 MCP 工具服务器：`tools/list` 返回全部 14 个内置工具，`tools/call` 直接执行 |
| 授权策略 | 服务级 `require_approval` | 勾选后该服务的工具视为写操作，调用前走审批流程 |

实测：注册 `tests/mock_mcp_server.py`（本地 mock）→ 自动同步 2 个工具；`tools/call` 正常返回。

### 技能（Skills）

- `app/skills/service.py` + `app/db/models.py:Skill`：名称 / 描述 / 完整指令（Markdown）/ 启用开关，内置 4 个技能
  （企业风险评估报告、多企业对比分析、预警处置建议、舆情专项研判）
- **渐进式披露**（保持 system 提示词静态 → 缓存友好）：
  1. system 提示词只写一句"需要专门方法时用 list_skills / load_skill"
  2. `list_skills` 只返回名称 + 描述（不污染上下文）
  3. `load_skill(name)` 返回完整指令，模型随后严格按指令执行
- 前端「技能库」面板支持新建/编辑/启停/删除；Agent 调用技能时会自动打开该面板

实测：提问"用「企业风险评估报告」技能分析一下康美药业" → Agent 依次调用
`search_enterprise → list_skills → load_skill → get_score_profile → get_risk_facts ×2`，
最终按技能模板输出「企业概况 / 风险评级 / 六维评分 / 关键风险点 / 处置建议」结构报告。

## 7. 不做的

- ❌ 不做多 Agent 编排（Planner/Executor 分离）——单 Agent + 工具足够，避免过度设计
- ❌ 不引入 WebSocket——SSE 单向流足够，实现更简单
- ❌ 不做向量记忆库——当前数据规模用关系查询 + 会话窗口即可

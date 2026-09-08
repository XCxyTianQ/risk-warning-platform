# 架构草图（v0, MVP：财务/法律/舆情三维度）

## 分层

```
web (Vue3+TS+ECharts)
  │  /api/* (FastAPI, CORS)
  ▼
server (FastAPI)
  ├── api/            # 路由（企业、预警、报告、后台）
  ├── services/       # 业务服务（指标计算、预警策略、台账）
  ├── llm/            # 大模型接入层
  │     ├── client.py   # OpenAI 兼容网关（配置三参数 + 错误分档）
  │     ├── agent.py    # 风险研判循环（工具调用）
  │     ├── tools.py    # 工具注册表（查财务/查涉诉/查舆情/查规则）
  │     └── memory.py   # 企业信号事实库（增量提取 + 原子写盘）
  ├── core/config.py  # 环境变量配置
  └── db/             # SQLite(原型) → PostgreSQL(正式)
        ├── enterprise / legal / news / finance / fact / alert
```

## 纵向切片数据流（阶段2 目标）

```
1 家企业样本
  ├─ 涉诉记录(20条) + 新闻(30条) + 财报(1份)  ─→ 入库
  ▼
mock_llm(或 DeepSeek) ── agent 循环 ──▶ 各维度风险信号(事实)
  ▼
规则引擎(3维度×3条，红/橙/黄) ──▶ 企业风险等级 + 证据引用
  ▼
/api/enterprise/{id}/risk ──▶ 企业详情页(雷达图+时间线+证据 tab)
```

## 关键决策

- 模型调用一律走 OpenAI 兼容三参数（mock → DeepSeek 无缝切换）
- 预警必须有证据引用（事实来自 memory 库），便于人工复核
- 原型期 SQLite、单文件 JSON 事实库；正式版换 PostgreSQL（表结构先留接口）
- 驾驶舱大屏复用开源模板，不做自研可视化框架

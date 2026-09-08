# AkShare 接入难度评估与架构优化方案

> 结论：**AkShare 整合难度中等偏低（约 6~8 人天）**，但当前架构有 5 处耦合会放大改造成本。
> 建议先做一次轻量重构（数据源抽象层），再接入 AkShare——一次投入，后续接付费 API/人工导入都零成本。
>
> **进度**：S1（数据源抽象层）+ S2（AkShare 接入）已完成 ✅ —— 见 `server/app/datasources/`，
> 实测茅台/康美刷新成功（真实财报 + 新闻 + 诉讼统计入库，评分自动重算）。

---

## 1. 实测：AkShare 能覆盖哪些维度（2026-09 实测）

| 风险维度 | AkShare 接口 | 粒度 | 实测 | 可用性 |
|---|---|---|---|---|
| 财务 | `stock_financial_abstract` / `stock_financial_report_sina` | 逐企业 | ✅ 80 指标 × 105 期 | **直接可用** |
| 公告 | `stock_individual_notice_report` | 逐企业 | ✅ 155 条（含公告类型/链接） | **直接可用** |
| 舆情 | `stock_news_em` | 逐企业 | ✅ 标题+正文+时间+来源 | **直接可用**（情感需自算） |
| 法律（诉讼统计） | `stock_cg_lawsuit_cninfo` | **逐企业** | ✅ 沪市一次 215 条（证券代码/诉讼次数/诉讼金额） | **可直接用于法律维度打分** |
| 股权质押 | `stock_cg_equity_mortgage_cninfo` | 全市场按日期 | ✅ 可批量 | 可用作信用维度辅助信号 |
| 失信/被执行/行政处罚 | — | — | ❌ 无免费接口 | 需付费 API 或人工 |
| 工商（非上市） | — | — | ❌ 无免费接口 | 人工导入 / 付费 API |

**结论**：上市公司可做到 **财务 + 公告 + 舆情 + 诉讼** 四类自动；失信/被执行与中小企业工商仍需付费源或人工。
接口稳定性实测 5 次调用 1 次失败（`stock_individual_info_em` 连接重置）→ 必须做重试与降级。

---

## 2. 整合难度分解

| 工作项 | 难度 | 人天 | 说明 |
|---|---|---|---|
| DataFrame → 统一记录（宽表转置、单位换算、日期解析） | 中 | 2 | 财务摘要是 80×105 宽表，需按报告期转行；单位统一为万元 |
| 企业标识映射（企业名 ↔ 股票代码/信用代码） | 中 | 1 | 需新增映射表 + 手工维护；非上市企业走人工 |
| 舆情情感标注 | 中 | 1 | 源无情感字段 → 用 flash 模型批量分类（便宜），关键词规则兜底 |
| 缓存/限流/重试/降级 | 中低 | 1 | 全市场接口一次返回上千行，必须缓存 |
| 幂等增量入库 | 中低 | 1 | 当前 seed 是"清空重灌"，需改为唯一键 upsert |
| 定时刷新调度 | 低 | 0.5 | APScheduler 足够 |
| 诉讼统计映射（次数/金额 → 法律维度） | 低 | 0.5 | 字段直接对应 |
| **合计** | — | **6~8** | 不含付费 API 采购与人工采集 |

---

## 3. 当前架构的 5 处问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | `llm/tools.py` 直接查 DB 模型 | 业务与数据访问耦合，换数据源要改 Agent 工具 |
| 2 | `services/rules.py` 阈值硬编码 | 调参需改代码重启，答辩演示无法现场调整 |
| 3 | `db/seed.py` 清空重灌 | 无法增量更新、无法多源合并（样例数据会被真实数据冲掉） |
| 4 | 无数据源抽象 | AkShare/付费 API/人工导入的逻辑会散落在各处 |
| 5 | 无采集日志与定时任务 | 不知道数据来自哪个源、何时拉取、是否失败 |

---

## 4. 目标架构（分层 + 依赖倒置）

```
app/
├── api/                  HTTP 路由（薄层）
│   ├── enterprises.py    企业/研判
│   ├── dashboard.py      驾驶舱聚合
│   └── datasources.py    ★新：数据源状态、手动触发刷新
├── services/             业务编排
│   ├── risk.py           研判流程（LLM + 工具 + 交叉校验）
│   └── scoring/          ★新：从 rules.py 提升
│       ├── engine.py     六维评分计算
│       └── config.py     阈值外置（可 DB 覆盖，演示可现场调参）
├── datasources/          ★新：外部数据接入层（依赖倒置核心）
│   ├── base.py           DataSource 协议 + NormalizedRecord + FetchResult
│   ├── registry.py       源注册表 / 维度降级链 / TTL 缓存
│   ├── akshare_src.py    财务 / 公告 / 新闻 / 诉讼
│   ├── manual_src.py     CSV/Excel 导入（成员3 采集）
│   └── paid_src.py       企查查/天眼查（预留，配置开关）
├── ingest/               ★新：规范化与落库
│   ├── normalizer.py     DataFrame → 统一记录
│   ├── pipeline.py       拉取→规范化→去重 upsert→触发评分
│   └── scheduler.py      APScheduler 定时刷新
├── llm/                  已有：client / tools / agent / memory
├── db/                   models / database / seed（seed 降级为"样例数据源"）
└── core/                 config（+ logging）
```

**核心接口（草稿）**

```python
# datasources/base.py
class NormalizedRecord:          # 统一记录（带来源可追溯）
    kind: str                    # finance | news | legal
    external_id: str             # 源内唯一键（用于幂等）
    source: str                  # akshare:stock_financial_abstract
    fetched_at: datetime
    raw_ref: str                 # 原始链接/接口参数
    payload: dict

class DataSource(Protocol):
    name: str
    dimensions: list[str]        # 支持哪些维度
    def fetch(self, ent: Enterprise, since: date | None = None) -> FetchResult: ...

# datasources/registry.py
registry.for_dimension("finance")   # → [akshare_src, paid_src, manual_src] 按优先级
result = registry.fetch("finance", ent)   # 失败自动降级，返回 gaps 标注缺失
```

**关键机制**

| 机制 | 设计 |
|---|---|
| 降级链 | 每维度配置源优先级；主源失败 → 备用源 → 缓存快照 → 记录 `data_gap`（不阻塞研判） |
| 幂等 | 唯一键 `(enterprise_id, source, external_id)` upsert，重复拉取不产生脏数据 |
| 可观测 | 新表 `ingest_log`（源/耗时/条数/状态/错误）→ 前端"数据源"页展示 |
| 缓存 | 全市场类接口（诉讼/质押）结果落 SQLite，TTL 内复用，避免重复拉取 |
| 阈值外置 | `scoring/config.py` 默认值 + DB 覆盖，支持"演示现场调阈值看分数变化" |
| 情感标注 | `llm/sentiment.py` 批量分类（flash 模型）+ 关键词规则兜底 |

---

## 5. 迁移步骤（每步可验证、可回滚）

| 步骤 | 内容 | 验收 | 人天 |
|---|---|---|---|
| **S1 抽象层落地** | 新增 `datasources/base.py` + `manual_src`（把现有 seed 包装成数据源）+ `ingest/pipeline` | 5 家企业评分与现在**完全一致**（回归基线） | 1~1.5 |
| **S2 AkShare 接入** | `akshare_src.py`（财务/公告/新闻）+ `enterprise_identifier` 映射 | 输入股票代码 → 自动入库 → 评分变化 | 2~3 |
| **S3 自动化与观测** | APScheduler 定时刷新 + `ingest_log` + `/api/datasources` + 前端数据源页 | 前端可看到源状态与最近拉取记录 | 1~2 |
| **S4 法律维度与情感** | 诉讼统计接入 + LLM 情感标注 + 付费源接口预留 | 法律维度由真实诉讼次数/金额驱动 | 1~1.5 |

> 建议先做 S1+S2（约 3~4.5 人天），就能看到"真实数据驱动的评分画像"。

---

## 6. 明确不做的（避免过度设计）

- ❌ 不引入 Celery/Kafka/微服务：单机 APScheduler + 同步管道足够（数据量 <10 万条）
- ❌ 不上图数据库：关系表 + 简单关联够用
- ❌ 不爬裁判文书网/公示系统：验证码与合规风险高，坚持"公开数据 + 授权 API"
- ❌ 不追全量企业：先覆盖上市公司（免费源）+ 少量非上市（人工），答辩叙事更清晰

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| AkShare 接口偶发失败（实测 1/5） | 重试 + 备用源 + 缓存；失败记 `data_gap` 不阻塞 |
| 上游字段/版本变动 | 适配层隔离，锁定版本；normalizer 单测覆盖字段映射 |
| 全市场接口数据量大 | TTL 缓存 + 只取关注企业；必要时按板块分页 |
| 情感判断不准 | LLM 分类 + 关键词规则双通道，抽样人工复核 |
| 非上市企业无免费源 | 人工导入模板（成员3）+ 付费源预留 |

"""工具注册表 —— 设计照搬 reasonmc McpTools（见 docs/reasonmc-调研.md）。

接口：
- register(name, schema, handler)：注册工具（schema 为 OpenAI function 格式）
- definitions()：全部工具 schema（调试/文档用）
- tools_for_request()：随 body 发送的 tools 数组
- call(name, args) -> str：按名分发执行；未知工具 / 执行异常 → 返回 "ERROR: ..."
  （不回抛，让 LLM 自行决定下一步 —— reasonmc 同款策略）

阶段2 首批工具（数据源：本地样例库）：
- get_finance_data / get_legal_records / get_news：按企业取数（LLM 取数通道）
- get_rules：把规则阈值交给 LLM 参考，降低幻觉
"""

import json


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, tuple[dict, object]] = {}

    def register(self, name: str, schema: dict, handler) -> None:
        if name in self._tools:
            raise ValueError(f"tool already registered: {name}")
        self._tools[name] = (schema, handler)

    def definitions(self) -> list[dict]:
        return [t[0] for t in self._tools.values()]

    def tools_for_request(self) -> list[dict]:
        return self.definitions()

    def call(self, name: str, args: dict) -> str:
        entry = self._tools.get(name)
        if entry is None:
            return f"ERROR: unknown tool {name}"
        try:
            result = entry[1](args)
            if isinstance(result, (dict, list)):
                return json.dumps(result, ensure_ascii=False)
            return str(result)
        except Exception as exc:  # noqa: BLE001 —— 回注错误文本，不中断 Agent 循环
            return f"ERROR: {exc}"


# ---------------------------------------------------------------------------
# 阶段2 数据工具（读取本地样例库，后续替换为采集/API 数据源）
# ---------------------------------------------------------------------------

def _entity_summary(ent) -> dict:
    return {
        "name": ent.name,
        "legal_rep": ent.legal_rep,
        "reg_capital_wan": ent.reg_capital_wan,
        "reg_date": ent.reg_date,
        "industry": ent.industry,
        "address": ent.address,
        "data_note": ent.data_note,
    }


def build_data_tools(db, enterprise_id: int) -> ToolRegistry:
    from app.db.models import Enterprise, Finance, LegalRecord, News

    reg = ToolRegistry()
    ent = db.get(Enterprise, enterprise_id)

    def get_finance_data(args: dict):
        rows = (
            db.query(Finance)
            .filter(Finance.enterprise_id == enterprise_id)
            .order_by(Finance.year)
            .all()
        )
        if not rows:
            return {"available": False, "note": "未上市企业，无公开财报（数据不足）", "enterprise": _entity_summary(ent)}
        return {"available": True, "reports": [
            {"year": r.year, "total_assets": r.total_assets, "total_liabilities": r.total_liabilities,
             "revenue": r.revenue, "net_profit": r.net_profit, "debt_ratio": r.debt_ratio, "source": r.source}
            for r in rows
        ]}

    def get_legal_records(args: dict):
        rows = (
            db.query(LegalRecord)
            .filter(LegalRecord.enterprise_id == enterprise_id)
            .order_by(LegalRecord.judgment_date.desc())
            .all()
        )
        return {"total": len(rows), "records": [
            {"case_no": r.case_no, "doc_type": r.doc_type, "title": r.title, "court": r.court,
             "cause": r.cause, "amount": r.amount, "status": r.status, "date": r.judgment_date, "source": r.source}
            for r in rows
        ]}

    def get_news(args: dict):
        rows = (
            db.query(News)
            .filter(News.enterprise_id == enterprise_id)
            .order_by(News.published_at.desc())
            .limit(30)
            .all()
        )
        return {"total": len(rows), "items": [
            {"title": n.title, "source": n.source, "date": n.published_at,
             "sentiment": n.sentiment, "url": n.url}
            for n in rows
        ]}

    def get_rules(args: dict):
        return {
            "levels": {"red": "高风险", "orange": "较高风险", "yellow": "关注", "green": "正常", "gray": "数据不足"},
            "legal": {"thresholds": "涉诉 ≥3 → orange；≥10 → red；≥1 → yellow"},
            "news": {"thresholds": "负面舆情占比 ≥30% → orange；≥50% → red；≥10% → yellow"},
            "finance": {"thresholds": "未上市无财报 → 数据不足(gray)，不参与定级"},
        }

    reg.register("get_entity_profile", {
        "type": "function",
        "function": {"name": "get_entity_profile", "description": "获取企业工商档案", "parameters": {"type": "object", "properties": {}}},
    }, lambda args: _entity_summary(ent))
    reg.register("get_finance_data", {
        "type": "function",
        "function": {"name": "get_finance_data", "description": "获取企业财务指标（财报/资产负债/营收利润）", "parameters": {"type": "object", "properties": {}}},
    }, get_finance_data)
    reg.register("get_legal_records", {
        "type": "function",
        "function": {"name": "get_legal_records", "description": "获取企业涉诉与司法/行政记录", "parameters": {"type": "object", "properties": {}}},
    }, get_legal_records)
    reg.register("get_news", {
        "type": "function",
        "function": {"name": "get_news", "description": "获取企业近期舆情新闻（含情感标签）", "parameters": {"type": "object", "properties": {}}},
    }, get_news)
    reg.register("get_rules", {
        "type": "function",
        "function": {"name": "get_rules", "description": "获取风险等级判定规则阈值（研判时参考）", "parameters": {"type": "object", "properties": {}}},
    }, get_rules)
    return reg

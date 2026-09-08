"""Agent 工具注册表：模型只能通过工具访问数据与动作。

设计对齐 Harness/Codex：
- 工具 schema 集中声明（OpenAI function 格式）
- 只读工具直接执行；动作工具（run_risk_analysis）标记 read_only=False
- 执行异常转成结构化错误返回给模型，不中断循环
"""

import json
from dataclasses import dataclass
from typing import Callable

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import Enterprise, News, RiskFact
from app.services.rules import DIM_META, rules_verdict


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: Callable[..., dict]
    read_only: bool = True

    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def definitions(self) -> list[dict]:
        return [t.schema() for t in self._tools.values()]

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def call(self, name: str, args: dict, db: Session) -> dict:
        tool = self._tools.get(name)
        if tool is None:
            return {"error": f"unknown tool: {name}"}
        try:
            return tool.handler(db, **args)
        except TypeError as exc:
            return {"error": f"参数错误: {exc}"}
        except Exception as exc:  # noqa: BLE001 —— 回注错误，让模型自行调整
            return {"error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------

def _brief(ent: Enterprise, verdict: dict) -> dict:
    return {
        "id": ent.id,
        "name": ent.name,
        "industry": ent.industry,
        "score": verdict["score"],
        "grade": verdict["grade"],
        "level": verdict["level"],
    }


def build_registry() -> ToolRegistry:
    reg = ToolRegistry()

    def search_enterprise(db: Session, keyword: str = "", limit: int = 5) -> dict:
        q = db.query(Enterprise)
        if keyword:
            q = q.filter(
                (Enterprise.name.contains(keyword)) | (Enterprise.industry.contains(keyword))
            )
        rows = q.limit(limit).all()
        return {
            "count": len(rows),
            "enterprises": [_brief(e, rules_verdict(db, e.id)) for e in rows],
            "hint": "如需详细画像请调用 get_score_profile(enterprise_id)" if rows else "未找到企业，可尝试其他关键词",
        }

    def get_score_profile(db: Session, enterprise_id: int) -> dict:
        ent = db.get(Enterprise, enterprise_id)
        if ent is None:
            return {"error": f"企业不存在: {enterprise_id}"}
        v = rules_verdict(db, enterprise_id)
        return {
            "enterprise": {"id": ent.id, "name": ent.name, "industry": ent.industry,
                           "legal_rep": ent.legal_rep, "reg_date": ent.reg_date, "data_note": ent.data_note},
            "score": v["score"],
            "grade": v["grade"],
            "grade_label": v["grade_label"],
            "level": v["level"],
            "dimensions": {
                k: {"label": DIM_META[k], "score": v["dimensions"][k]["score"],
                    "level": v["dimensions"][k]["level"], "note": v["dimensions"][k]["note"]}
                for k in DIM_META
            },
        }

    def get_risk_facts(db: Session, enterprise_id: int, dimension: str = "", limit: int = 10) -> dict:
        q = db.query(RiskFact).filter(RiskFact.enterprise_id == enterprise_id)
        if dimension:
            q = q.filter(RiskFact.dimension == dimension)
        rows = q.order_by(RiskFact.ts.desc()).limit(limit).all()
        ent = db.get(Enterprise, enterprise_id)
        return {
            "enterprise_id": enterprise_id,
            "enterprise_name": ent.name if ent else "",
            "count": len(rows),
            "facts": [
                {
                    "dimension": f.dimension,
                    "dimension_label": DIM_META.get(f.dimension, f.dimension),
                    "text": f.text,
                    "evidence": json.loads(f.evidence_json) if f.evidence_json else {},
                    "confidence": f.confidence,
                }
                for f in rows
            ],
        }

    def list_enterprises_by_level(db: Session, level: str = "red") -> dict:
        rows = db.query(Enterprise).all()
        out = []
        for e in rows:
            v = rules_verdict(db, e.id)
            if v["level"] == level:
                out.append(_brief(e, v))
        out.sort(key=lambda x: (x["score"] if x["score"] is not None else 999))
        return {"level": level, "count": len(out), "enterprises": out}

    def get_platform_overview(db: Session) -> dict:
        rows = db.query(Enterprise).all()
        levels: dict[str, int] = {}
        scores = []
        for e in rows:
            v = rules_verdict(db, e.id)
            levels[v["level"]] = levels.get(v["level"], 0) + 1
            if v["score"] is not None:
                scores.append(v["score"])
        sentiment = dict(
            db.query(News.sentiment, func.count(News.id)).group_by(News.sentiment).all()
        )
        return {
            "enterprise_total": len(rows),
            "avg_score": round(sum(scores) / len(scores), 1) if scores else None,
            "level_counts": levels,
            "risk_fact_total": db.query(func.count(RiskFact.id)).scalar() or 0,
            "news_sentiment": sentiment,
        }

    def run_risk_analysis(db: Session, enterprise_id: int) -> dict:
        """动作工具：触发一次完整研判（大模型 + 规则交叉校验），耗时 10~40 秒。"""
        from app.services.risk import analyze_enterprise

        result = analyze_enterprise(db, enterprise_id)
        v = result["verdict"]
        return {
            "enterprise_id": enterprise_id,
            "enterprise": result["enterprise"]["name"],
            "score": v["score"],
            "grade": v["grade"],
            "level": v["level"],
            "llm_level": v["llm_level"],
            "rules_level": v["rules_level"],
            "cross_check_ok": v["cross_check_ok"],
            "summary": v["summary"],
            "evidence_count": len(v["evidence"]),
            "evidence": v["evidence"][:8],
        }

    reg.register(Tool(
        name="search_enterprise",
        description="按企业名称或行业关键词搜索企业，返回 id/名称/行业/评分/等级。首次接触某企业时先调用它拿到 id。",
        parameters={
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "description": "企业名称或行业关键词"},
                "limit": {"type": "integer", "description": "返回条数，默认 5"},
            },
            "required": ["keyword"],
        },
        handler=search_enterprise,
    ))
    reg.register(Tool(
        name="get_score_profile",
        description="获取指定企业的六维评分画像（财务健康/法律合规/舆情声誉/经营能力/信用状况/供应链稳定）、综合评分与 AAA~C 评级。",
        parameters={
            "type": "object",
            "properties": {"enterprise_id": {"type": "integer", "description": "企业 id（来自 search_enterprise）"}},
            "required": ["enterprise_id"],
        },
        handler=get_score_profile,
    ))
    reg.register(Tool(
        name="get_risk_facts",
        description="获取企业已沉淀的风险事实与证据（含来源与置信度），可按维度筛选。",
        parameters={
            "type": "object",
            "properties": {
                "enterprise_id": {"type": "integer"},
                "dimension": {"type": "string", "description": "可选：finance/legal/news/operation/credit/supply"},
                "limit": {"type": "integer", "description": "默认 10"},
            },
            "required": ["enterprise_id"],
        },
        handler=get_risk_facts,
    ))
    reg.register(Tool(
        name="list_enterprises_by_level",
        description="列出指定风险等级的企业（red/orange/yellow/green），按评分升序。",
        parameters={
            "type": "object",
            "properties": {"level": {"type": "string", "description": "red/orange/yellow/green，默认 red"}},
            "required": [],
        },
        handler=list_enterprises_by_level,
    ))
    reg.register(Tool(
        name="get_platform_overview",
        description="获取平台整体统计：企业总数、平均评分、各风险等级数量、风险事实总数。",
        parameters={"type": "object", "properties": {}, "required": []},
        handler=get_platform_overview,
    ))
    reg.register(Tool(
        name="run_risk_analysis",
        description="触发指定企业的完整风险研判（调用多模态大模型取数推理 + 规则引擎交叉校验），耗时 10~40 秒。仅在用户明确要求分析/重新研判时使用。",
        parameters={
            "type": "object",
            "properties": {"enterprise_id": {"type": "integer"}},
            "required": ["enterprise_id"],
        },
        handler=run_risk_analysis,
        read_only=False,
    ))
    return reg

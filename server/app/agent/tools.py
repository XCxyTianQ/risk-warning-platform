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

    def register_mcp(self, db: Session) -> int:
        """把启用的外部 MCP 服务工具注册进本次运行（每会话动态加载）。"""
        from app.mcp.client import McpClient
        from app.mcp.service import enabled_tools

        count = 0
        for item in enabled_tools(db):
            tool = item["tool"]
            name = item["openai_name"]
            url, auth, mcp_name, server_name = item["server_url"], item["auth_header"], tool.name, item["server_name"]

            def handler(_db: Session, _url=url, _auth=auth, _name=mcp_name, **kwargs):
                client = McpClient(_url, _auth)
                return {"mcp_result": client.call_tool(_name, kwargs)}

            try:
                self.register(Tool(
                    name=name,
                    description=f"[MCP:{server_name}] {tool.description or tool.name}",
                    parameters=tool.input_schema or {"type": "object", "properties": {}},
                    handler=handler,
                    read_only=not item["require_approval"],
                ))
                count += 1
            except ValueError:
                continue
        return count

    def register_custom_tools(self, db: Session) -> int:
        """注册用户手搓的声明式 HTTP 插件。"""
        from app.services.plugins import enabled_custom_tools, run_custom_tool

        count = 0
        for row in enabled_custom_tools(db):
            def handler(_db: Session, _row=row, **kwargs):
                return run_custom_tool(_row, kwargs)

            try:
                self.register(Tool(
                    name=f"custom_{row.name}"[:64],
                    description=f"[插件] {row.description or row.name}",
                    parameters=__import__("json").loads(row.parameters_json or "{}") or {"type": "object", "properties": {}},
                    handler=handler,
                    read_only=not row.require_approval,
                ))
                count += 1
            except ValueError:
                continue
        return count

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


def build_registry(preset: dict | None = None) -> ToolRegistry:
    """构建工具注册表。preset = {"tools": [白名单], "skills": [白名单]}（空=全部）。"""
    reg = ToolRegistry()
    allowed_tools = set((preset or {}).get("tools") or [])
    allowed_skills = set((preset or {}).get("skills") or [])
    ALWAYS = {"list_skills", "load_skill"}

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

    def list_alerts(db: Session, status: str = "", level: str = "", enterprise_id: int = 0, limit: int = 10) -> dict:
        """预警工单列表（可按状态/等级/企业筛选）。"""
        from app.services.alerts import list_alerts as _list

        return _list(
            db,
            status=status or None,
            level=level or None,
            enterprise_id=enterprise_id or None,
            limit=limit,
        )

    def handle_alert(db: Session, alert_id: int, action: str, handler: str = "", note: str = "") -> dict:
        """动作工具：处置预警（start 开始处理 / resolve 已处置 / ignore 忽略 / reopen 重新打开）。"""
        from app.services.alerts import handle_alert as _handle

        return _handle(db, alert_id, action, handler, note)

    def get_alert_report(db: Session, alert_id: int) -> dict:
        """生成预警报告（Markdown 文本）。"""
        from app.services.alerts import report_markdown

        text = report_markdown(db, alert_id)
        if not text:
            return {"error": f"预警不存在: {alert_id}"}
        return {"alert_id": alert_id, "report_markdown": text[:4000]}

    def refresh_enterprise_data(db: Session, enterprise_id: int, dimensions: str = "") -> dict:
        """动作工具：从公开数据源（AkShare）刷新企业财务/舆情/诉讼数据。"""
        from app.datasources import refresh_enterprise

        dims = [d.strip() for d in dimensions.split(",") if d.strip()] or None
        result = refresh_enterprise(db, enterprise_id, dims)
        if "error" in result:
            return result
        summary = {
            dim: ({"ok": info["ok"], "fetched": info.get("fetched", 0), "inserted": info.get("inserted", 0),
                   "updated": info.get("updated", 0), "gap": info.get("gap", ""), "error": info.get("error", "")})
            for dim, info in result["dimensions"].items()
        }
        return {"enterprise_id": enterprise_id, "enterprise": result["enterprise"]["name"], "dimensions": summary}

    def resolve_stock_code(db: Session, name: str) -> dict:
        """名称 → 股票代码候选（添加企业前确认）。"""
        from app.services.enterprise import lookup_stock

        return lookup_stock(name)

    def add_enterprise(db: Session, name: str, stock_code: str = "", auto_fetch: bool = True) -> dict:
        """动作工具：添加企业并（可选）自动拉取公开数据。"""
        from app.services.enterprise import create_enterprise

        result = create_enterprise(db, name, stock_code or None, auto_fetch)
        if "refresh" in result and isinstance(result["refresh"], dict):
            dims = result["refresh"].get("dimensions", {})
            result["refresh_summary"] = {
                d: (f"+{v.get('inserted', 0)}/~{v.get('updated', 0)}" if v.get("ok") else (v.get("gap") or v.get("error")))
                for d, v in dims.items()
            }
        return result

    def list_skills(db: Session) -> dict:
        """列出可用技能（只给名称与描述，避免污染上下文）。"""
        from app.skills.service import skills_for_tool

        items = skills_for_tool(db)
        if allowed_skills:
            items = [s for s in items if s["name"] in allowed_skills]
        return {"count": len(items), "skills": items,
                "hint": "选定后用 load_skill(name) 载入该技能的完整执行指令"}

    def load_skill(db: Session, name: str) -> dict:
        """载入技能完整指令，后续按该指令执行任务。"""
        from app.skills.service import get_by_name

        if allowed_skills and name not in allowed_skills:
            return {"error": f"当前预设未启用该技能：{name}", "available": sorted(allowed_skills)}
        row = get_by_name(db, name)
        if row is None or not row.enabled:
            from app.skills.service import skills_for_tool

            return {"error": f"技能不存在或已停用：{name}",
                    "available": [s["name"] for s in skills_for_tool(db)]}
        return {"skill": row.name, "description": row.description, "instructions": row.content}

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
        name="list_alerts",
        description="查询预警工单：可按状态（pending/handling/resolved/ignored）、等级（red/orange/yellow）、企业 id 筛选。用户问'有哪些预警/待处理预警'时使用。",
        parameters={
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "pending/handling/resolved/ignored"},
                "level": {"type": "string", "description": "red/orange/yellow"},
                "enterprise_id": {"type": "integer"},
                "limit": {"type": "integer", "description": "默认 10"},
            },
            "required": [],
        },
        handler=list_alerts,
    ))
    reg.register(Tool(
        name="handle_alert",
        description="处置预警工单（写操作，需授权）：start=开始处理，resolve=标记已处置，ignore=忽略，reopen=重新打开。",
        parameters={
            "type": "object",
            "properties": {
                "alert_id": {"type": "integer"},
                "action": {"type": "string", "description": "start/resolve/ignore/reopen"},
                "handler": {"type": "string", "description": "处理人"},
                "note": {"type": "string", "description": "处置说明"},
            },
            "required": ["alert_id", "action"],
        },
        handler=handle_alert,
        read_only=False,
    ))
    reg.register(Tool(
        name="get_alert_report",
        description="生成指定预警的处置报告（Markdown 文本，含证据链与处理流水）。",
        parameters={
            "type": "object",
            "properties": {"alert_id": {"type": "integer"}},
            "required": ["alert_id"],
        },
        handler=get_alert_report,
    ))
    reg.register(Tool(
        name="refresh_enterprise_data",
        description="从公开数据源（AkShare：财报/新闻/诉讼统计）刷新指定企业的数据并入库。仅上市公司有效（需有股票代码）。这是写操作，需用户授权。",
        parameters={
            "type": "object",
            "properties": {
                "enterprise_id": {"type": "integer"},
                "dimensions": {"type": "string", "description": "可选：逗号分隔的维度 finance,news,legal；默认全部"},
            },
            "required": ["enterprise_id"],
        },
        handler=refresh_enterprise_data,
        read_only=False,
    ))
    reg.register(Tool(
        name="resolve_stock_code",
        description="按企业名称查询 A 股股票代码候选（用于添加企业前确认标的）。",
        parameters={
            "type": "object",
            "properties": {"name": {"type": "string", "description": "企业/上市公司名称关键词"}},
            "required": ["name"],
        },
        handler=resolve_stock_code,
    ))
    reg.register(Tool(
        name="add_enterprise",
        description="添加一家新企业到平台（可自动解析股票代码并拉取公开数据：财报/新闻/诉讼）。这是写操作，需用户授权。",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "企业全称或常用名"},
                "stock_code": {"type": "string", "description": "可选：A股代码（不填则按名称自动解析）"},
                "auto_fetch": {"type": "boolean", "description": "是否自动拉取公开数据，默认 true"},
            },
            "required": ["name"],
        },
        handler=add_enterprise,
        read_only=False,
    ))
    reg.register(Tool(
        name="list_skills",
        description="列出平台可用技能（如「企业风险评估报告」「多企业对比分析」）。需要专门分析方法时先调用它。",
        parameters={"type": "object", "properties": {}, "required": []},
        handler=list_skills,
    ))
    reg.register(Tool(
        name="load_skill",
        description="载入指定技能的完整执行指令，然后严格按该指令完成任务。",
        parameters={
            "type": "object",
            "properties": {"name": {"type": "string", "description": "技能名称（来自 list_skills）"}},
            "required": ["name"],
        },
        handler=load_skill,
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

    # 预设工具白名单过滤（list_skills / load_skill 始终保留，便于技能发现）
    if allowed_tools:
        for name in list(reg._tools):
            if name not in allowed_tools and name not in ALWAYS:
                reg._tools.pop(name, None)
    return reg

"""用户手搓插件（声明式 HTTP 工具）与 Agent 预设。

对齐 DSH 的设计理念：
- **插件**：声明 name / description / parameters(JSON Schema) + HTTP 调用模板（URL/Headers/Body 支持 {arg} 占位），
  不写代码即可接入任意 REST 接口，注册后 Agent 可直接调用；
- **预设**：把"提示词补充 + 工具白名单 + 技能白名单 + 模型覆盖"组合成一个 Agent 人格，
  会话可选预设（相当于 DSH 的 cordis.yml 组合，只是这里用界面/数据库表达）。
"""

import json
from datetime import datetime

import httpx
from sqlalchemy.orm import Session as DbSession

from app.db.models import AgentPreset, CustomTool

BUILTIN_PRESETS = [
    {
        "name": "通用风险分析师",
        "description": "默认预设：全工具、全技能，平衡型风险分析",
        "prompt_extra": "你以稳健、克制的方式分析风险，结论先行，证据必附来源。",
        "tools_json": "[]",
        "skills_json": "[]",
    },
    {
        "name": "合规审查专员",
        "description": "聚焦法律合规与信用维度，只读工具为主，输出合规风险清单",
        "prompt_extra": "你专注合规视角：优先关注司法、行政、失信与监管问询信号；"
                       "对每个结论标注法规/监管依据来源；不给出投资建议。",
        "tools_json": json.dumps(["search_enterprise", "get_score_profile", "get_risk_facts",
                                  "list_skills", "load_skill", "get_alert_report"]),
        "skills_json": json.dumps(["企业风险评估报告", "预警处置建议"]),
    },
    {
        "name": "投资尽调助手",
        "description": "面向投前尽调：财务+经营+舆情并重，输出要点与风险提示",
        "prompt_extra": "你服务投前尽调：先给结论与关键指标，再给风险清单与需补充材料清单；"
                       "明确区分「事实」与「推断」。",
        "tools_json": json.dumps(["search_enterprise", "get_score_profile", "get_risk_facts",
                                  "list_enterprises_by_level", "get_platform_overview", "list_skills", "load_skill"]),
        "skills_json": json.dumps(["企业风险评估报告", "多企业对比分析", "舆情专项研判"]),
    },
]


# ---------------------------------------------------------------------------
# 插件（自定义工具）
# ---------------------------------------------------------------------------

def list_custom_tools(db: DbSession) -> dict:
    rows = db.query(CustomTool).order_by(CustomTool.id).all()
    return {"total": len(rows), "items": [
        {
            "id": r.id, "name": r.name, "description": r.description,
            "parameters": json.loads(r.parameters_json or "{}"),
            "method": r.method, "url": r.url,
            "headers": json.loads(r.headers_json or "{}"),
            "body_template": r.body_template,
            "enabled": r.enabled, "require_approval": r.require_approval, "builtin": r.builtin,
        }
        for r in rows
    ]}


def create_custom_tool(db: DbSession, **fields) -> dict:
    name = (fields.get("name") or "").strip()
    if not name:
        return {"error": "工具名称不能为空"}
    if not (fields.get("url") or "").strip():
        return {"error": "调用地址不能为空"}
    if db.query(CustomTool).filter(CustomTool.name == name).first():
        return {"error": f"工具已存在：{name}"}
    row = CustomTool(
        name=name,
        description=fields.get("description") or "",
        parameters_json=json.dumps(fields.get("parameters") or {"type": "object", "properties": {}}, ensure_ascii=False),
        method=(fields.get("method") or "GET").upper(),
        url=fields.get("url") or "",
        headers_json=json.dumps(fields.get("headers") or {}, ensure_ascii=False),
        body_template=fields.get("body_template") or "",
        enabled=bool(fields.get("enabled", True)),
        require_approval=bool(fields.get("require_approval", False)),
    )
    db.add(row)
    db.commit()
    return {"tool_id": row.id, "name": row.name}


def update_custom_tool(db: DbSession, tool_id: int, **fields) -> dict:
    row = db.get(CustomTool, tool_id)
    if row is None:
        return {"error": f"工具不存在: {tool_id}"}
    if "name" in fields and fields["name"]:
        row.name = fields["name"]
    if "description" in fields and fields["description"] is not None:
        row.description = fields["description"]
    if "parameters" in fields and fields["parameters"] is not None:
        row.parameters_json = json.dumps(fields["parameters"], ensure_ascii=False)
    if "method" in fields and fields["method"]:
        row.method = fields["method"].upper()
    if "url" in fields and fields["url"]:
        row.url = fields["url"]
    if "headers" in fields and fields["headers"] is not None:
        row.headers_json = json.dumps(fields["headers"], ensure_ascii=False)
    if "body_template" in fields and fields["body_template"] is not None:
        row.body_template = fields["body_template"]
    if "enabled" in fields and fields["enabled"] is not None:
        row.enabled = bool(fields["enabled"])
    if "require_approval" in fields and fields["require_approval"] is not None:
        row.require_approval = bool(fields["require_approval"])
    db.commit()
    return {"ok": True, "tool_id": row.id}


def delete_custom_tool(db: DbSession, tool_id: int) -> dict:
    row = db.get(CustomTool, tool_id)
    if row is None:
        return {"error": f"工具不存在: {tool_id}"}
    if row.builtin:
        return {"error": "内置工具不可删除"}
    name = row.name
    db.delete(row)
    db.commit()
    return {"deleted": tool_id, "name": name}


def _render(template: str, args: dict) -> str:
    out = template or ""
    for k, v in (args or {}).items():
        out = out.replace("{" + k + "}", str(v))
    return out


def run_custom_tool(row: CustomTool, args: dict) -> dict:
    """执行声明式 HTTP 调用（供 Agent 工具与"测试"按钮共用）。"""
    url = _render(row.url, args)
    headers = {}
    try:
        headers = json.loads(row.headers_json or "{}")
    except ValueError:
        headers = {}
    headers = {k: _render(str(v), args) for k, v in headers.items()}
    body = None
    if row.method in ("POST", "PUT", "PATCH"):
        if row.body_template:
            rendered = _render(row.body_template, args)
            try:
                body = json.loads(rendered)
            except ValueError:
                body = rendered
        else:
            body = args
    with httpx.Client(timeout=30) as c:
        resp = c.request(row.method, url, headers=headers, json=body)
    text = resp.text[:4000]
    if resp.status_code // 100 != 2:
        return {"error": f"HTTP {resp.status_code}: {text[:300]}"}
    try:
        return {"status": resp.status_code, "data": resp.json()}
    except ValueError:
        return {"status": resp.status_code, "text": text}


def enabled_custom_tools(db: DbSession) -> list[CustomTool]:
    return db.query(CustomTool).filter(CustomTool.enabled.is_(True)).order_by(CustomTool.id).all()


# ---------------------------------------------------------------------------
# Agent 预设
# ---------------------------------------------------------------------------

def list_presets(db: DbSession) -> dict:
    rows = db.query(AgentPreset).order_by(AgentPreset.builtin.desc(), AgentPreset.id).all()
    return {"total": len(rows), "items": [
        {
            "id": r.id, "name": r.name, "description": r.description,
            "prompt_extra": r.prompt_extra,
            "tools": json.loads(r.tools_json or "[]"),
            "skills": json.loads(r.skills_json or "[]"),
            "model_override": r.model_override,
            "enabled": r.enabled, "builtin": r.builtin,
        }
        for r in rows
    ]}


def get_preset(db: DbSession, preset_id: int | None) -> AgentPreset | None:
    if not preset_id:
        return None
    row = db.get(AgentPreset, preset_id)
    return row if row and row.enabled else None


def create_preset(db: DbSession, **fields) -> dict:
    name = (fields.get("name") or "").strip()
    if not name:
        return {"error": "预设名称不能为空"}
    if db.query(AgentPreset).filter(AgentPreset.name == name).first():
        return {"error": f"预设已存在：{name}"}
    row = AgentPreset(
        name=name,
        description=fields.get("description") or "",
        prompt_extra=fields.get("prompt_extra") or "",
        tools_json=json.dumps(fields.get("tools") or [], ensure_ascii=False),
        skills_json=json.dumps(fields.get("skills") or [], ensure_ascii=False),
        model_override=fields.get("model_override") or "",
        enabled=bool(fields.get("enabled", True)),
    )
    db.add(row)
    db.commit()
    return {"preset_id": row.id, "name": row.name}


def update_preset(db: DbSession, preset_id: int, **fields) -> dict:
    row = db.get(AgentPreset, preset_id)
    if row is None:
        return {"error": f"预设不存在: {preset_id}"}
    for key, attr in (("name", "name"), ("description", "description"), ("prompt_extra", "prompt_extra"),
                      ("model_override", "model_override")):
        if key in fields and fields[key] is not None:
            setattr(row, attr, fields[key])
    if "tools" in fields and fields["tools"] is not None:
        row.tools_json = json.dumps(fields["tools"], ensure_ascii=False)
    if "skills" in fields and fields["skills"] is not None:
        row.skills_json = json.dumps(fields["skills"], ensure_ascii=False)
    if "enabled" in fields and fields["enabled"] is not None:
        row.enabled = bool(fields["enabled"])
    row.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "preset_id": row.id}


def delete_preset(db: DbSession, preset_id: int) -> dict:
    row = db.get(AgentPreset, preset_id)
    if row is None:
        return {"error": f"预设不存在: {preset_id}"}
    if row.builtin:
        return {"error": "内置预设不可删除，可停用或另存为新预设"}
    name = row.name
    db.delete(row)
    db.commit()
    return {"deleted": preset_id, "name": name}


def seed_builtin_presets(db: DbSession) -> int:
    created = 0
    for item in BUILTIN_PRESETS:
        if db.query(AgentPreset).filter(AgentPreset.name == item["name"]).first():
            continue
        db.add(AgentPreset(**item, builtin=True, enabled=True))
        created += 1
    if created:
        db.commit()
    return created

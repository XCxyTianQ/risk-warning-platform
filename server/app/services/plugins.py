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
    {
        "name": "财务分析师",
        "description": "聚焦财报：杜邦分解 + Z/F/M 模型 + 同业对标 + 异常勾稽，输出财务分析结论",
        "prompt_extra": "你是财务分析师：所有数字必须来自工具返回的财报指标，并标注年份与单位；"
                       "模型结论要写明阈值与输入完整度（可计算/近似/缺失），缺失即说明缺失，不得推测；"
                       "对异常信号要给出可能原因与需进一步核实的材料清单；不构成投资建议。",
        "tools_json": json.dumps(["search_enterprise", "get_financial_analysis", "compare_financials",
                                  "screen_by_financial_metric", "get_score_profile", "get_risk_facts",
                                  "refresh_enterprise_data", "list_skills", "load_skill"]),
        "skills_json": json.dumps(["财务分析", "多企业对比分析", "企业风险评估报告"]),
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


# ---------------------------------------------------------------------------
# 导入 / 导出（JSON 分享包）
# ---------------------------------------------------------------------------

BUNDLE_KIND = "risk-warning-agent-bundle"
BUNDLE_VERSION = 1


def _skill_dict(db: DbSession, name: str) -> dict | None:
    from app.db.models import Skill

    row = db.query(Skill).filter(Skill.name == name).first()
    if row is None:
        return None
    return {"name": row.name, "description": row.description, "content": row.content}


def _tool_dict(db: DbSession, name: str) -> dict | None:
    """name 可为 custom_xxx 或 xxx。"""
    raw = name[7:] if name.startswith("custom_") else name
    row = db.query(CustomTool).filter(CustomTool.name == raw).first()
    if row is None:
        return None
    return {
        "name": row.name, "description": row.description,
        "parameters": json.loads(row.parameters_json or "{}"),
        "method": row.method, "url": row.url,
        "headers": json.loads(row.headers_json or "{}"),
        "body_template": row.body_template,
        "require_approval": row.require_approval,
    }


def export_preset(db: DbSession, preset_id: int) -> dict:
    """导出单个预设（含其引用的技能与自定义插件，保证可移植）。"""
    row = db.get(AgentPreset, preset_id)
    if row is None:
        return {"error": f"预设不存在: {preset_id}"}
    preset = next((p for p in list_presets(db)["items"] if p["id"] == preset_id), None)
    skills = [s for name in (preset or {}).get("skills", []) if (s := _skill_dict(db, name))]
    tools = [t for name in (preset or {}).get("tools", []) if (t := _tool_dict(db, name))]
    return {
        "kind": BUNDLE_KIND,
        "version": BUNDLE_VERSION,
        "exported_at": datetime.utcnow().isoformat(),
        "presets": [preset],
        "skills": skills,
        "tools": tools,
    }


def export_all(db: DbSession) -> dict:
    """导出全部预设 + 技能 + 插件。"""
    return {
        "kind": BUNDLE_KIND,
        "version": BUNDLE_VERSION,
        "exported_at": datetime.utcnow().isoformat(),
        "presets": list_presets(db)["items"],
        "skills": list_skills_dict(db),
        "tools": list_custom_tools(db)["items"],
    }


def list_skills_dict(db: DbSession) -> list[dict]:
    from app.db.models import Skill

    rows = db.query(Skill).order_by(Skill.id).all()
    return [{"name": r.name, "description": r.description, "content": r.content} for r in rows]


def _unique_name(db: DbSession, model, name: str) -> str:
    base = name
    i = 1
    while db.query(model).filter(model.name == name).first():
        i += 1
        name = f"{base}（导入{i}）"
    return name


def import_bundle(db: DbSession, data: dict, strategy: str = "rename") -> dict:
    """导入分享包。strategy: skip（跳过同名）/ rename（重命名）/ overwrite（覆盖）。"""
    if not isinstance(data, dict) or data.get("kind") != BUNDLE_KIND:
        return {"error": f"不是有效的分享包（kind 应为 {BUNDLE_KIND}）"}
    if int(data.get("version") or 0) > BUNDLE_VERSION:
        return {"error": f"分享包版本过新（{data.get('version')} > {BUNDLE_VERSION}），请升级平台"}

    result = {"tools": [], "skills": [], "presets": [], "skipped": [], "strategy": strategy}

    def conflict(model, name: str) -> tuple[object | None, str]:
        existing = db.query(model).filter(model.name == name).first()
        if existing is None:
            return None, name
        if strategy == "skip":
            return existing, name
        if strategy == "overwrite":
            return existing, name
        return None, _unique_name(db, model, name)

    # 1) 插件（同名且 URL/方法一致 → 直接复用，不重复导入）
    for t in data.get("tools") or []:
        name = (t.get("name") or "").strip()
        if not name:
            continue
        existing = db.query(CustomTool).filter(CustomTool.name == name).first()
        if existing is not None and existing.url == (t.get("url") or "") and existing.method == (t.get("method") or "GET").upper():
            result["tools"].append(f"{name}（已存在，复用）")
            continue
        existing, final = conflict(CustomTool, name)
        if existing is not None and strategy == "skip":
            result["skipped"].append(f"插件 {name}")
            continue
        payload = {
            "description": t.get("description") or "",
            "parameters_json": json.dumps(t.get("parameters") or {}, ensure_ascii=False),
            "method": (t.get("method") or "GET").upper(),
            "url": t.get("url") or "",
            "headers_json": json.dumps(t.get("headers") or {}, ensure_ascii=False),
            "body_template": t.get("body_template") or "",
            "require_approval": bool(t.get("require_approval", False)),
        }
        if existing is not None:
            for k, v in payload.items():
                setattr(existing, k, v)
            result["tools"].append(f"{name}（覆盖）")
        else:
            db.add(CustomTool(name=final, enabled=True, **payload))
            result["tools"].append(final)

    # 2) 技能（同名且内容一致 → 复用，避免重复）
    from app.db.models import Skill

    for s in data.get("skills") or []:
        name = (s.get("name") or "").strip()
        if not name or not (s.get("content") or "").strip():
            continue
        existing = db.query(Skill).filter(Skill.name == name).first()
        if existing is not None and (existing.content or "").strip() == (s.get("content") or "").strip():
            result["skills"].append(f"{name}（已存在，复用）")
            continue
        existing, final = conflict(Skill, name)
        if existing is not None and strategy == "skip":
            result["skipped"].append(f"技能 {name}")
            continue
        if existing is not None:
            existing.description = s.get("description") or existing.description
            existing.content = s.get("content") or existing.content
            result["skills"].append(f"{name}（覆盖）")
        else:
            db.add(Skill(name=final, description=s.get("description") or "", content=s.get("content") or ""))
            result["skills"].append(final)

    # 3) 预设（最后导入，工具/技能已就位）
    for p in data.get("presets") or []:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        existing, final = conflict(AgentPreset, name)
        if existing is not None and strategy == "skip":
            result["skipped"].append(f"预设 {name}")
            continue
        payload = {
            "description": p.get("description") or "",
            "prompt_extra": p.get("prompt_extra") or "",
            "tools_json": json.dumps(p.get("tools") or [], ensure_ascii=False),
            "skills_json": json.dumps(p.get("skills") or [], ensure_ascii=False),
            "model_override": p.get("model_override") or "",
        }
        if existing is not None:
            for k, v in payload.items():
                setattr(existing, k, v)
            existing.updated_at = datetime.utcnow()
            result["presets"].append(f"{name}（覆盖）")
        else:
            db.add(AgentPreset(name=final, enabled=True, **payload))
            result["presets"].append(final)

    db.commit()
    return result

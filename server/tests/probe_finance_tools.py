# -*- coding: utf-8 -*-
"""金融分析 Agent 工具探针：直接调用工具处理器（不经过 LLM）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_finance_tools.py
输出：tests/_finance_tools.txt（UTF-8）
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.agent.tools import build_registry
from app.db.database import SessionLocal, init_db
from app.db.models import AgentPreset, Enterprise, Skill
from app.services.plugins import seed_builtin_presets
from app.skills.service import seed_builtin

lines: list[str] = []


def log(*parts) -> None:
    text = " ".join(str(p) for p in parts)
    print(text)
    lines.append(text)


init_db()
db = SessionLocal()
try:
    seed_builtin(db)
    seed_builtin_presets(db)

    reg = build_registry()
    names = [t["function"]["name"] for t in reg.definitions()]
    log("tools:", len(names))
    log("finance tools registered:", [n for n in names if "financ" in n or n.startswith("screen")])

    ent = db.query(Enterprise).filter(Enterprise.name.contains("康美")).first()
    log("target:", ent.id, ent.name)

    a = reg.call("get_financial_analysis", {"enterprise_id": ent.id}, db)
    log("get_financial_analysis keys:", list(a.keys()))
    log("  kpi count:", len(a.get("kpi", [])), "anomalies:", len(a.get("anomalies", [])))
    log("  models:", json.dumps(a.get("models"), ensure_ascii=False)[:600])
    log("  peers rows:", len((a.get("peers") or {}).get("rows", [])))

    maotai = db.query(Enterprise).filter(Enterprise.name.contains("茅台")).first()
    cmp_ = reg.call("compare_financials", {"enterprise_ids": [ent.id, maotai.id]}, db)
    log("compare_financials:", json.dumps(cmp_, ensure_ascii=False)[:700])

    scr = reg.call("screen_by_financial_metric", {"metric": "debt_ratio", "op": "gt", "value": 70}, db)
    log("screen debt_ratio>70:", scr.get("count"), [i["name"] for i in scr.get("items", [])])
    scr2 = reg.call("screen_by_financial_metric", {"metric": "roe", "op": "lt", "value": 0}, db)
    log("screen roe<0:", scr2.get("count"), [i["name"] for i in scr2.get("items", [])])

    # 预设与技能入库校验
    presets = [p.name for p in db.query(AgentPreset).all()]
    skills = [s.name for s in db.query(Skill).all()]
    log("presets:", presets)
    log("skills:", skills)

    # 预设白名单过滤：财务分析师预设下可用工具
    row = db.query(AgentPreset).filter(AgentPreset.name == "财务分析师").first()
    if row:
        preset = {"tools": json.loads(row.tools_json or "[]"), "skills": json.loads(row.skills_json or "[]")}
        reg2 = build_registry(preset)
        log("财务分析师 preset tools:", [t["function"]["name"] for t in reg2.definitions()])
        sk = reg2.call("list_skills", {}, db)
        log("财务分析师 preset skills:", [s["name"] for s in sk["skills"]])

    pathlib.Path(__file__).with_name("_finance_tools.txt").write_text("\n".join(lines), encoding="utf-8")
    print("saved tests/_finance_tools.txt")
finally:
    db.close()

"""预警中心：生成 / 列表 / 处置流转 / 报告导出。

闭环：数据刷新或研判 → 评分触发预警 → 人工处置（待处理→处理中→已处置/已忽略）→ 处理流水留痕。
"""

import json
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.db.models import Alert, Enterprise, RiskFact
from app.services.rules import DIM_META, rules_verdict

LEVEL_BY_SCORE = [(55, "red"), (70, "orange"), (85, "yellow")]
STATUS_LABEL = {
    "pending": "待处理",
    "handling": "处理中",
    "resolved": "已处置",
    "ignored": "已忽略",
}
OPEN_STATUS = ("pending", "handling")


def _level_of(score: float | None) -> str | None:
    if score is None:
        return None
    for threshold, level in LEVEL_BY_SCORE:
        if score < threshold:
            return level
    return None  # ≥85 正常，不预警


def generate_for_enterprise(db: DbSession, enterprise_id: int, source: str = "scoring") -> dict:
    """按当前评分生成预警（幂等：同一企业+维度+等级存在未关闭工单则跳过）。"""
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        return {"error": f"企业不存在: {enterprise_id}"}

    verdict = rules_verdict(db, enterprise_id)
    created: list[dict] = []
    skipped = 0

    def create(level: str, dimension: str, title: str, summary: str, score, evidence) -> None:
        nonlocal skipped
        fp = f"{enterprise_id}:{dimension}:{level}"
        exists = (
            db.query(Alert)
            .filter(Alert.fingerprint == fp, Alert.status.in_(OPEN_STATUS))
            .first()
        )
        if exists:
            skipped += 1
            return
        db.add(Alert(
            enterprise_id=enterprise_id,
            level=level,
            dimension=dimension,
            title=title,
            summary=summary,
            evidence_json=json.dumps(evidence, ensure_ascii=False),
            score=score,
            source=source,
            fingerprint=fp,
        ))
        created.append({"level": level, "dimension": dimension, "title": title, "score": score})

    # 维度级预警
    for dim, info in verdict["dimensions"].items():
        level = _level_of(info.get("score"))
        if level is None:
            continue
        facts = (
            db.query(RiskFact)
            .filter(RiskFact.enterprise_id == enterprise_id, RiskFact.dimension == dim)
            .order_by(RiskFact.ts.desc())
            .limit(3)
            .all()
        )
        evidence = [
            {"text": f.text, **({"source": (json.loads(f.evidence_json) or {}).get("source", "")} if f.evidence_json else {})}
            for f in facts
        ]
        if not evidence:
            # 无 LLM 事实时，用规则指标作为证据（保证报告有据可依）
            evidence = [{"text": info.get("note", ""), "source": "规则引擎指标"}]
        create(
            level, dim,
            f"{DIM_META.get(dim, dim)}风险预警（{info['score']} 分）",
            info.get("note", ""),
            info.get("score"),
            evidence,
        )

    # 综合级预警
    overall_level = verdict["level"]
    if overall_level in ("red", "orange"):
        create(
            overall_level, "overall",
            f"综合风险预警：{ent.name}（{verdict['score']} 分 / {verdict['grade']}）",
            f"六维综合评级 {verdict['grade']}（{verdict['grade_label']}），建议按预警流程核查处置。",
            verdict["score"],
            [{"dimension": d, "score": v["score"], "note": v.get("note", "")}
             for d, v in verdict["dimensions"].items() if v.get("score") is not None],
        )

    db.commit()
    return {"enterprise_id": enterprise_id, "enterprise": ent.name, "created": created, "skipped": skipped}


def generate_all(db: DbSession, source: str = "scoring") -> dict:
    rows = db.query(Enterprise).all()
    result = {"enterprises": len(rows), "created": 0, "skipped": 0, "details": []}
    for ent in rows:
        r = generate_for_enterprise(db, ent.id, source)
        result["created"] += len(r.get("created", []))
        result["skipped"] += r.get("skipped", 0)
        if r.get("created"):
            result["details"].append({"enterprise": ent.name, "created": len(r["created"])})
    return result


def list_alerts(
    db: DbSession,
    status: str | None = None,
    level: str | None = None,
    enterprise_id: int | None = None,
    limit: int = 200,
) -> dict:
    q = db.query(Alert, Enterprise.name).join(Enterprise, Enterprise.id == Alert.enterprise_id)
    if status:
        q = q.filter(Alert.status == status)
    if level:
        q = q.filter(Alert.level == level)
    if enterprise_id:
        q = q.filter(Alert.enterprise_id == enterprise_id)
    rows = q.order_by(Alert.created_at.desc()).limit(limit).all()
    items = []
    for a, ent_name in rows:
        items.append({
            "id": a.id,
            "enterprise_id": a.enterprise_id,
            "enterprise": ent_name,
            "level": a.level,
            "dimension": a.dimension,
            "dimension_label": DIM_META.get(a.dimension, "综合" if a.dimension == "overall" else a.dimension),
            "title": a.title,
            "summary": a.summary,
            "score": a.score,
            "status": a.status,
            "status_label": STATUS_LABEL.get(a.status, a.status),
            "handler": a.handler,
            "created_at": a.created_at.isoformat(),
            "updated_at": a.updated_at.isoformat(),
            "handled_at": a.handled_at.isoformat() if a.handled_at else None,
            "notes": json.loads(a.notes_json or "[]"),
            "evidence": json.loads(a.evidence_json or "[]"),
        })
    return {"total": len(items), "items": items}


def summary(db: DbSession) -> dict:
    rows = db.query(Alert.status, Alert.level).all()
    by_status: dict[str, int] = {}
    by_level: dict[str, int] = {}
    for status, level in rows:
        by_status[status] = by_status.get(status, 0) + 1
        by_level[level] = by_level.get(level, 0) + 1
    return {
        "total": len(rows),
        "by_status": {k: by_status.get(k, 0) for k in STATUS_LABEL},
        "by_level": by_level,
        "pending": by_status.get("pending", 0),
        "handling": by_status.get("handling", 0),
    }


def handle_alert(db: DbSession, alert_id: int, action: str, handler: str = "", note: str = "") -> dict:
    """处置流转：start(开始处理) / resolve(已处置) / ignore(忽略) / reopen(重新打开)。"""
    alert = db.get(Alert, alert_id)
    if alert is None:
        return {"error": f"预警不存在: {alert_id}"}
    transitions = {
        "start": ("handling", {"pending", "handling", "ignored", "resolved"}),
        "resolve": ("resolved", {"pending", "handling"}),
        "ignore": ("ignored", {"pending", "handling"}),
        "reopen": ("pending", {"resolved", "ignored"}),
    }
    if action not in transitions:
        return {"error": f"不支持的动作: {action}（可选 start/resolve/ignore/reopen）"}
    new_status, allowed = transitions[action]
    if alert.status not in allowed:
        return {"error": f"当前状态「{STATUS_LABEL.get(alert.status)}」不能执行 {action}"}

    alert.status = new_status
    alert.updated_at = datetime.utcnow()
    if handler:
        alert.handler = handler
    if new_status in ("resolved", "ignored"):
        alert.handled_at = alert.updated_at
    notes = json.loads(alert.notes_json or "[]")
    notes.append({
        "ts": alert.updated_at.isoformat(),
        "action": action,
        "status": new_status,
        "status_label": STATUS_LABEL.get(new_status),
        "handler": handler or alert.handler,
        "note": note,
    })
    alert.notes_json = json.dumps(notes, ensure_ascii=False)
    db.commit()
    return {
        "alert_id": alert.id,
        "status": alert.status,
        "status_label": STATUS_LABEL.get(alert.status),
        "handler": alert.handler,
        "notes": notes,
    }


def report_markdown(db: DbSession, alert_id: int) -> str:
    """生成预警报告（Markdown，可下载/打印）。"""
    alert = db.get(Alert, alert_id)
    if alert is None:
        return ""
    ent = db.get(Enterprise, alert.enterprise_id)
    evidence = json.loads(alert.evidence_json or "[]")
    notes = json.loads(alert.notes_json or "[]")
    lines = [
        f"# 企业经营风险预警报告",
        "",
        f"- **企业**：{ent.name if ent else '-'}（id={alert.enterprise_id}）",
        f"- **预警等级**：{alert.level} · {alert.title}",
        f"- **维度**：{DIM_META.get(alert.dimension, '综合')}",
        f"- **评分**：{alert.score if alert.score is not None else '—'}",
        f"- **状态**：{STATUS_LABEL.get(alert.status, alert.status)}｜处理人：{alert.handler or '—'}",
        f"- **生成时间**：{alert.created_at.isoformat()}",
        f"- **数据来源**：公开信源（东方财富 / 新浪财经 / 巨潮资讯，经 AkShare 接入）",
        "",
        "## 预警摘要",
        "",
        alert.summary or "（无）",
        "",
        "## 证据链",
        "",
    ]
    if evidence:
        for i, ev in enumerate(evidence, 1):
            if isinstance(ev, dict):
                text = ev.get("text") or ev.get("note") or json.dumps(ev, ensure_ascii=False)
                src = ev.get("source") or ev.get("dimension") or ""
                lines.append(f"{i}. {text}" + (f"（来源：{src}）" if src else ""))
            else:
                lines.append(f"{i}. {ev}")
    else:
        lines.append("（暂无证据记录，建议重新研判或刷新数据）")
    lines += ["", "## 处置流水", ""]
    if notes:
        for n in notes:
            lines.append(f"- {n.get('ts', '')[:19]} · {n.get('status_label', '')} · {n.get('handler', '')} · {n.get('note', '')}")
    else:
        lines.append("（尚未处置）")
    lines += ["", "---", "", "> 本报告由「企业经营风险预警平台」自动生成，数据来自公开信源，不构成投资建议。"]
    return "\n".join(lines)

"""驾驶舱聚合接口（前端总览/预警视图数据源）。"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import Enterprise, News, RiskFact
from app.services.rules import DIM_META, rules_verdict

router = APIRouter(prefix="/api", tags=["dashboard"])

DIM_LABEL = {k: v for k, v in DIM_META.items()}


@router.get("/dashboard/summary")
def dashboard_summary(db: Session = Depends(get_db)):
    enterprises = db.query(Enterprise).order_by(Enterprise.id).all()

    level_counts = {"red": 0, "orange": 0, "yellow": 0, "green": 0}
    dim_level_counts: dict[str, dict[str, int]] = {d: {} for d in DIM_LABEL}
    rows = []
    for ent in enterprises:
        verdict = rules_verdict(db, ent.id)
        level_counts[verdict["level"]] = level_counts.get(verdict["level"], 0) + 1
        for dim, info in verdict["dimensions"].items():
            lv = info["level"]
            dim_level_counts.setdefault(dim, {})
            dim_level_counts[dim][lv] = dim_level_counts[dim].get(lv, 0) + 1
        rows.append({
            "id": ent.id,
            "name": ent.name,
            "stock_code": ent.stock_code,
            "industry": ent.industry,
            "level": verdict["level"],
            "score": verdict["score"],
            "grade": verdict["grade"],
            "grade_label": verdict["grade_label"],
            "dimensions": {d: verdict["dimensions"][d]["level"] for d in verdict["dimensions"]},
            "dimension_scores": {d: verdict["dimensions"][d]["score"] for d in verdict["dimensions"]},
            "indicators": verdict["indicators"],
        })

    facts = (
        db.query(RiskFact, Enterprise.name)
        .join(Enterprise, Enterprise.id == RiskFact.enterprise_id)
        .order_by(RiskFact.ts.desc())
        .limit(12)
        .all()
    )
    sentiment_rows = (
        db.query(News.sentiment, func.count(News.id)).group_by(News.sentiment).all()
    )
    scores = [r["score"] for r in rows if r["score"] is not None]
    return {
        "enterprise_total": len(enterprises),
        "avg_score": round(sum(scores) / len(scores), 1) if scores else None,
        "level_counts": level_counts,
        "dimension_levels": dim_level_counts,
        "enterprises": rows,
        "fact_total": db.query(func.count(RiskFact.id)).scalar() or 0,
        "recent_facts": [
            {
                "enterprise": name,
                "dimension": f.dimension,
                "text": f.text,
                "ts": f.ts.isoformat(),
            }
            for f, name in facts
        ],
        "news_sentiment": {s: c for s, c in sentiment_rows},
    }


@router.get("/risk-facts")
def list_risk_facts(
    dimension: str | None = Query(None),
    enterprise_id: int | None = Query(None),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
):
    q = (
        db.query(RiskFact, Enterprise.name)
        .join(Enterprise, Enterprise.id == RiskFact.enterprise_id)
    )
    if dimension:
        q = q.filter(RiskFact.dimension == dimension)
    if enterprise_id:
        q = q.filter(RiskFact.enterprise_id == enterprise_id)
    rows = q.order_by(RiskFact.ts.desc()).limit(limit).all()
    return {
        "total": len(rows),
        "items": [
            {
                "id": f.id,
                "enterprise_id": f.enterprise_id,
                "enterprise": name,
                "dimension": f.dimension,
                "dimension_label": DIM_LABEL.get(f.dimension, f.dimension),
                "text": f.text,
                "confidence": f.confidence,
                "ts": f.ts.isoformat(),
            }
            for f, name in rows
        ],
    }

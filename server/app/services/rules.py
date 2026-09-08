"""规则引擎雏形（阶段2）：基于入库数据计算指标 → 红/橙/黄。

与 LLM 研判的关系：本模块输出"规则参考等级"，LLM 输出"研判结论"，
两者交叉校验：不一致时以规则为准并标记 mismatch（阶段2 策略）。
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import Enterprise, Finance, LegalRecord, News

LEVEL_ORDER = {"green": 0, "yellow": 1, "orange": 2, "red": 3}


def compute_indicators(db: Session, enterprise_id: int) -> dict:
    """六维中的 MVP 三维指标（财务/法律/舆情）。"""
    legal_total = db.query(func.count(LegalRecord.id)).filter(
        LegalRecord.enterprise_id == enterprise_id
    ).scalar() or 0
    legal_amount = db.query(
        func.coalesce(func.sum(LegalRecord.amount), 0.0)
    ).filter(LegalRecord.enterprise_id == enterprise_id).scalar() or 0.0

    news_total = db.query(func.count(News.id)).filter(
        News.enterprise_id == enterprise_id
    ).scalar() or 0
    news_negative = db.query(func.count(News.id)).filter(
        News.enterprise_id == enterprise_id, News.sentiment == "negative"
    ).scalar() or 0
    negative_ratio = round(news_negative / news_total, 3) if news_total else 0.0

    # 财务维度：取最新一期财报
    finance_rows = (
        db.query(Finance)
        .filter(Finance.enterprise_id == enterprise_id)
        .order_by(Finance.year.desc())
        .all()
    )
    if finance_rows:
        latest = finance_rows[0]
        finance = {
            "available": True,
            "year": latest.year,
            "debt_ratio": latest.debt_ratio,
            "net_profit": latest.net_profit,
            "revenue": latest.revenue,
            "source": latest.source,
        }
    else:
        finance = {"available": False, "note": "未上市/无公开财报（数据不足）"}
    return {
        "finance": finance,
        "legal": {"count": legal_total, "amount": legal_amount},
        "news": {"total": news_total, "negative": news_negative, "negative_ratio": negative_ratio},
    }


def dim_level(dim: str, ind: dict) -> str:
    """单维度等级（规则雏形，阈值后续按评测调参）。"""
    if dim == "legal":
        c = ind["legal"]["count"]
        if c >= 10:
            return "red"
        if c >= 3:
            return "orange"
        if c >= 1:
            return "yellow"
        return "green"
    if dim == "news":
        r = ind["news"]["negative_ratio"]
        if r >= 0.5:
            return "red"
        if r >= 0.3:
            return "orange"
        if r >= 0.1:
            return "yellow"
        return "green"
    if dim == "finance":
        fin = ind["finance"]
        if not fin.get("available"):
            return "gray"  # 数据不足：不参与定级
        debt = fin.get("debt_ratio") or 0
        profit = fin.get("net_profit") or 0
        if debt >= 85 or (profit < 0 and debt >= 70):
            return "red"
        if debt >= 70 or profit < 0:
            return "orange"
        if debt >= 60:
            return "yellow"
        return "green"
    return "green"


def rules_verdict(db: Session, enterprise_id: int) -> dict:
    ind = compute_indicators(db, enterprise_id)
    dims = {}
    for d in ("finance", "legal", "news"):
        level = dim_level(d, ind) if d != "finance" else dim_level("finance", ind)
        dims[d] = {"level": level, "indicators": ind[d]}
    scored = [dims[d]["level"] for d in dims if dims[d]["level"] != "gray"]
    level = max(scored, key=lambda x: LEVEL_ORDER[x]) if scored else "green"
    return {"level": level, "dimensions": dims, "indicators": ind}

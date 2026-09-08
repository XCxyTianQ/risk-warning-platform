"""六维企业评分引擎。设计：
- 每个维度输出 0~100 分（越高越健康）与等级；数据不足的维度输出 None + gray，不参与综合评分。
- 综合评分 = 可用维度加权平均；映射到 AAA~C 信用式等级。
- 与 LLM 研判的关系：本模块输出"规则评分"，LLM 输出"研判结论"，
  两者交叉校验（不一致时以规则为准，阶段2 策略）。

维度（6）：
  finance   财务健康   资产负债率、净利润、亏损
  legal     法律合规   涉诉数量、涉案金额、行政处罚、刑事
  news      舆情声誉   负面舆情占比、近期负面
  operation 经营能力   成立年限、营收增长、净利润率
  credit    信用状况   失信、被执行、行政处罚
  supply    供应链稳定 合同类纠纷、供应商相关负面舆情
"""

from datetime import date, timedelta
import json

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import Enterprise, Finance, LegalRecord, News

LEVEL_ORDER = {"green": 0, "yellow": 1, "orange": 2, "red": 3}

DIM_META: dict[str, str] = {
    "finance": "财务健康",
    "legal": "法律合规",
    "news": "舆情声誉",
    "operation": "经营能力",
    "credit": "信用状况",
    "supply": "供应链稳定",
}

# 综合评分 → 等级（信用评级风格）
GRADE_TABLE = [
    (90, "AAA", "优秀"),
    (80, "AA", "良好"),
    (70, "A", "稳健"),
    (60, "BBB", "关注"),
    (50, "BB", "预警"),
    (0, "C", "高风险"),
]

SUPPLY_KEYWORDS = ("合同", "买卖", "运输", "采购", "供货", "交付")
SUPPLY_NEWS_KEYWORDS = ("供应商", "断供", "交付", "产能", "供应链")


def _clamp(v: float) -> int:
    return int(max(0, min(100, round(v))))


def score_to_level(score: int | None) -> str:
    if score is None:
        return "gray"
    if score >= 85:
        return "green"
    if score >= 70:
        return "yellow"
    if score >= 55:
        return "orange"
    return "red"


def grade_of(score: float | None) -> tuple[str, str]:
    if score is None:
        return "—", "数据不足"
    for threshold, grade, label in GRADE_TABLE:
        if score >= threshold:
            return grade, label
    return "C", "高风险"


def _parse_date(s: str) -> date | None:
    s = (s or "").strip()
    if len(s) >= 10:
        try:
            return date.fromisoformat(s[:10])
        except ValueError:
            pass
    if len(s) == 7:
        try:
            return date.fromisoformat(s + "-01")
        except ValueError:
            pass
    return None


def _age_years(reg_date: str) -> int | None:
    d = _parse_date(reg_date)
    if d is None:
        return None
    return max(0, (date.today() - d).days // 365)


# ---------------------------------------------------------------------------
# 原始信号
# ---------------------------------------------------------------------------

def compute_indicators(db: Session, enterprise_id: int) -> dict:
    ent = db.get(Enterprise, enterprise_id)
    try:
        data_status = json.loads(ent.data_status_json or "{}") if ent else {}
    except ValueError:
        data_status = {}

    # --- 财务 ---
    finance_rows = (
        db.query(Finance)
        .filter(Finance.enterprise_id == enterprise_id)
        .order_by(Finance.year.desc())
        .all()
    )
    if finance_rows:
        latest = finance_rows[0]
        prev = finance_rows[1] if len(finance_rows) > 1 else None
        growth = None
        if prev and prev.revenue:
            growth = round((latest.revenue - prev.revenue) / abs(prev.revenue) * 100, 1)
        margin = round(latest.net_profit / latest.revenue * 100, 1) if latest.revenue else None
        finance = {
            "available": True,
            "year": latest.year,
            "debt_ratio": latest.debt_ratio,
            "net_profit": latest.net_profit,
            "revenue": latest.revenue,
            "revenue_growth": growth,
            "net_margin": margin,
            "source": latest.source,
            "loss_years": sum(1 for r in finance_rows if (r.net_profit or 0) < 0),
        }
    else:
        finance = {"available": False, "note": "未上市/无公开财报（数据不足）"}

    # --- 法律 / 信用 / 供应链（同源：司法与行政记录） ---
    legal_rows = (
        db.query(LegalRecord)
        .filter(LegalRecord.enterprise_id == enterprise_id)
        .all()
    )
    shixin = zhixing = penalty = criminal = contract_disputes = trademark_admin = 0
    for r in legal_rows:
        text = f"{r.doc_type} {r.title} {r.status} {r.cause}"
        if "失信" in text:
            shixin += 1
        if "被执行" in text:
            zhixing += 1
        if "行政处罚" in text or "处罚" in (r.doc_type or ""):
            penalty += 1
        if "刑事" in (r.doc_type or ""):
            criminal += 1
        if any(k in (r.cause or "") for k in SUPPLY_KEYWORDS):
            contract_disputes += 1
        if "商标" in text:
            trademark_admin += 1
    legal_amount = sum((r.amount or 0) for r in legal_rows)

    # --- 舆情 ---
    news_rows = (
        db.query(News).filter(News.enterprise_id == enterprise_id).all()
    )
    news_total = len(news_rows)
    news_negative = sum(1 for n in news_rows if n.sentiment == "negative")
    cutoff = date.today() - timedelta(days=365)
    recent_negative = sum(
        1 for n in news_rows
        if n.sentiment == "negative" and (_parse_date(n.published_at) or date.min) >= cutoff
    )
    supply_news_negative = sum(
        1 for n in news_rows
        if n.sentiment == "negative" and any(k in (n.title or "") for k in SUPPLY_NEWS_KEYWORDS)
    )
    negative_ratio = round(news_negative / news_total, 3) if news_total else 0.0

    # --- 经营 ---
    operation = {
        "age_years": _age_years(ent.reg_date) if ent else None,
        "revenue_growth": finance.get("revenue_growth"),
        "net_margin": finance.get("net_margin"),
    }

    return {
        "data_status": data_status,
        "finance": finance,
        "legal": {
            "count": len(legal_rows),
            "amount": legal_amount,
            "penalty": penalty,
            "criminal": criminal,
            "trademark_admin": trademark_admin,
        },
        "news": {
            "total": news_total,
            "negative": news_negative,
            "negative_ratio": negative_ratio,
            "recent_negative": recent_negative,
        },
        "operation": operation,
        "credit": {"shixin": shixin, "zhixing": zhixing, "penalty": penalty},
        "supply": {"contract_disputes": contract_disputes, "supply_news_negative": supply_news_negative},
    }


# ---------------------------------------------------------------------------
# 维度评分
# ---------------------------------------------------------------------------

def _status(ind: dict, dim: str) -> str:
    return (ind.get("data_status") or {}).get(dim, "never")


def dim_score(dim: str, ind: dict) -> tuple[int | None, str]:
    """返回 (score, note)。score=None 表示"无数据/未采集"，不参与综合评分。

    关键原则：**没有数据 ≠ 没有风险**。
    - status=ok：查到记录，按规则打分
    - status=empty：查过且确实没有（如无诉讼、无负面新闻），可判 0 风险
    - status=never/error：从未采集或拉取失败 → 该维度 gray，不参与评分
    """

    if dim == "finance":
        if _status(ind, "finance") != "ok" or not ind["finance"].get("available"):
            return None, "无公开财报数据（未采集或数据不足）"
        fin = ind["finance"]
        s = 100.0
        debt = fin.get("debt_ratio") or 0
        if debt >= 85:
            s -= 45
        elif debt >= 70:
            s -= 30
        elif debt >= 60:
            s -= 15
        if (fin.get("net_profit") or 0) < 0:
            s -= 25
        if fin.get("loss_years", 0) >= 2:
            s -= 10
        return _clamp(s), f"资产负债率 {debt}% · 净利润 {fin.get('net_profit')} 万（{fin.get('year')}）"

    if dim == "legal":
        st = _status(ind, "legal")
        if st not in ("ok", "empty"):
            return None, "司法数据未采集（数据不足）"
        s = 100.0
        s -= min(50, ind["legal"]["count"] * 6)
        s -= min(25, ind["legal"]["penalty"] * 10)
        s -= min(20, ind["legal"]["criminal"] * 20)
        s -= min(15, ind["legal"]["trademark_admin"] * 4)
        if ind["legal"]["amount"] >= 10000:
            s -= 10
        return _clamp(s), f"司法/行政记录 {ind['legal']['count']} 项 · 涉案 {ind['legal']['amount']:.0f} 万"

    if dim == "news":
        st = _status(ind, "news")
        if st not in ("ok", "empty"):
            return None, "舆情数据未采集（数据不足）"
        n = ind["news"]
        s = 100.0
        s -= min(60, n["negative_ratio"] * 120)
        s -= min(15, n["recent_negative"] * 3)
        return _clamp(s), f"新闻 {n['total']} 条 · 负面 {n['negative']} 条（{round(n['negative_ratio'] * 100)}%）"

    if dim == "operation":
        op = ind["operation"]
        age = op.get("age_years")
        has_fin = _status(ind, "finance") == "ok" and (
            op.get("net_margin") is not None or op.get("revenue_growth") is not None
        )
        if age is None and not has_fin:
            return None, "无成立年限与财务数据（数据不足）"
        s = 95.0 if age is not None else 90.0
        if age is not None:
            if age < 2:
                s -= 10
            elif age < 5:
                s -= 5
            elif age >= 10:
                s += 5
        if op.get("net_margin") is not None:
            if op["net_margin"] < 0:
                s -= 30
            elif op["net_margin"] < 5:
                s -= 8
            elif op["net_margin"] > 20:
                s += 3
        if op.get("revenue_growth") is not None:
            if op["revenue_growth"] < 0:
                s -= 15
            elif op["revenue_growth"] > 20:
                s += 3
        note = f"成立 {age} 年" if age is not None else "成立年限未知"
        if op.get("net_margin") is not None:
            note += f" · 净利润率 {op['net_margin']}%"
        if op.get("revenue_growth") is not None:
            note += f" · 营收增速 {op['revenue_growth']}%"
        return _clamp(s), note

    if dim == "credit":
        if _status(ind, "legal") not in ("ok", "empty"):
            return None, "信用/司法数据未采集（数据不足）"
        c = ind["credit"]
        s = 100.0
        s -= min(45, c["shixin"] * 40)
        s -= min(35, c["zhixing"] * 30)
        s -= min(25, c["penalty"] * 12)
        note = f"失信 {c['shixin']} 次 · 被执行 {c['zhixing']} 次 · 行政处罚 {c['penalty']} 次"
        return _clamp(s), note

    if dim == "supply":
        if _status(ind, "legal") not in ("ok", "empty") and _status(ind, "news") not in ("ok", "empty"):
            return None, "供应链相关数据未采集（数据不足）"
        sp = ind["supply"]
        s = 100.0
        s -= min(45, sp["contract_disputes"] * 8)
        s -= min(25, sp["supply_news_negative"] * 8)
        note = f"合同类纠纷 {sp['contract_disputes']} 项 · 供应链负面舆情 {sp['supply_news_negative']} 条"
        return _clamp(s), note

    return None, "未知维度"


def rules_verdict(db: Session, enterprise_id: int) -> dict:
    """六维评分 + 综合评分 + 等级（规则引擎输出）。"""
    ind = compute_indicators(db, enterprise_id)
    dims: dict[str, dict] = {}
    scores: list[float] = []
    for dim in DIM_META:
        score, note = dim_score(dim, ind)
        level = score_to_level(score)
        dims[dim] = {
            "score": score,
            "level": level,
            "label": DIM_META[dim],
            "indicators": ind[dim],
            "note": note,
        }
        if score is not None:
            scores.append(score)

    overall = round(sum(scores) / len(scores), 1) if scores else None
    grade, grade_label = grade_of(overall)
    level = score_to_level(int(overall) if overall is not None else None)
    if not scores:
        grade, grade_label, level = "—", "无数据，无法评估", "gray"
    return {
        "score": overall,
        "grade": grade,
        "grade_label": grade_label,
        "level": level,
        "dimensions": dims,
        "indicators": ind,
        "data_status": ind.get("data_status", {}),
    }

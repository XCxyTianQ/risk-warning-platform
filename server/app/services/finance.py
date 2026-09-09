"""金融分析模块：把财报数据变成可计算的判断。

能力边界（六块）：
1. 概览 KPI：最新一期关键指标 + 同比变化；
2. 趋势序列：规模 / 盈利 / 偿债 / 营运 / 现金流 / 成长六组；
3. 杜邦分解：ROE = 净利率 × 总资产周转率 × 权益乘数，并做三因素归因；
4. 财务预警模型：Altman Z-Score / Z''-Score、Piotroski F-Score、Beneish M-Score；
5. 同业对标：同行业分位数与雷达对比；
6. 异常勾稽：规则引擎输出可疑信号（含证据）。

设计原则（与平台一致）：
- **缺失即不参与**：算不出的指标标注原因，不猜测、不填默认值；
- **口径可追溯**：每个指标标注来源（原始指标 / 派生 / 近似）与所属年份；
- **模型披露输入**：每个模型的输入项逐项给出 exact / approx / missing。
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

from sqlalchemy.orm import Session as DbSession

from app.db.models import Enterprise, Finance

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

DIM_LABELS = {
    "scale": "规模",
    "profit": "盈利能力",
    "solvency": "偿债与杠杆",
    "operation": "营运效率",
    "cashflow": "现金流质量",
    "growth": "成长性",
}

# 指标元数据：key → (标签, 单位, 分组, 是否越大越好)
METRIC_META: dict[str, tuple[str, str, str, bool]] = {
    "revenue": ("营业总收入", "万元", "scale", True),
    "net_profit": ("归母净利润", "万元", "scale", True),
    "net_profit_total": ("净利润（含少数股东）", "万元", "scale", True),
    "gross_margin": ("毛利率", "%", "profit", True),
    "net_margin": ("销售净利率", "%", "profit", True),
    "roe": ("净资产收益率 ROE", "%", "profit", True),
    "roa": ("总资产报酬率 ROA", "%", "profit", True),
    "operating_margin": ("营业利润率", "%", "profit", True),
    "debt_ratio": ("资产负债率", "%", "solvency", False),
    "current_ratio": ("流动比率", "倍", "solvency", True),
    "quick_ratio": ("速动比率", "倍", "solvency", True),
    "equity_multiplier": ("权益乘数", "倍", "solvency", False),
    "asset_turnover": ("总资产周转率", "次", "operation", True),
    "ar_days": ("应收账款周转天数", "天", "operation", False),
    "inventory_days": ("存货周转天数", "天", "operation", False),
    "ocf": ("经营活动现金流净额", "万元", "cashflow", True),
    "ocf_to_profit": ("现金含量（经营现金流/净利润）", "倍", "cashflow", True),
    "ocf_to_revenue": ("经营现金流/营业收入", "倍", "cashflow", True),
    "revenue_growth": ("营业总收入增速", "%", "growth", True),
    "profit_growth": ("归母净利润增速", "%", "growth", True),
    "goodwill_ratio": ("商誉/净资产", "%", "solvency", False),
    "deducted_ratio": ("扣非净利润/净利润", "倍", "profit", True),
    "deducted_profit": ("扣非净利润", "万元", "profit", True),
}


def _f(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _div(a, b) -> float | None:
    a, b = _f(a), _f(b)
    if a is None or b in (None, 0):
        return None
    return a / b


def _pct(a, b) -> float | None:
    r = _div(a, b)
    return None if r is None else round(r * 100, 4)


def _r(v, nd=4) -> float | None:
    return None if v is None else round(v, nd)


def _load_json(raw: str) -> dict:
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# 期间数据组装：metrics_json + 顶层字段 → 规范化期间序列
# ---------------------------------------------------------------------------

def load_periods(db: DbSession, enterprise_id: int, years: int = 5) -> list[dict]:
    rows = (
        db.query(Finance)
        .filter(Finance.enterprise_id == enterprise_id)
        .order_by(Finance.year.asc())
        .all()
    )
    rows = [r for r in rows if (r.year or "").strip()][-years:]
    periods: list[dict] = []
    for r in rows:
        m = _load_json(r.metrics_json)
        # 顶层字段兜底（老数据 / 样例数据只有顶层字段）
        for k, v in (
            ("revenue_wan", r.revenue),
            ("net_profit_wan", r.net_profit),
            ("total_assets_wan", r.total_assets),
            ("total_liabilities_wan", r.total_liabilities),
            ("debt_ratio", r.debt_ratio),
        ):
            if _f(v) and _f(m.get(k)) is None:
                m[k] = _f(v)

        p: dict = {
            "year": r.year,
            "report_type": r.report_type or "年报",
            "source": r.source or "",
            "raw": m,
        }
        p["revenue"] = _f(m.get("revenue_wan"))
        p["net_profit"] = _f(m.get("net_profit_wan"))
        p["net_profit_total"] = _f(m.get("net_profit_total_wan")) or p["net_profit"]
        p["total_assets"] = _f(m.get("total_assets_wan"))
        p["total_liabilities"] = _f(m.get("total_liabilities_wan"))
        p["equity"] = _f(m.get("equity_wan"))
        if p["equity"] is None and p["total_assets"] is not None and p["total_liabilities"] is not None:
            p["equity"] = round(p["total_assets"] - p["total_liabilities"], 2)
        p["debt_ratio"] = _f(m.get("debt_ratio"))
        p["ocf"] = _f(m.get("ocf_wan"))
        p["gross_margin"] = _f(m.get("gross_margin"))
        p["net_margin"] = _f(m.get("net_margin"))
        p["roe"] = _f(m.get("roe"))
        p["roa"] = _f(m.get("roa"))
        p["operating_margin"] = _f(m.get("operating_margin"))
        p["current_ratio"] = _f(m.get("current_ratio"))
        p["quick_ratio"] = _f(m.get("quick_ratio"))
        p["equity_multiplier"] = _f(m.get("equity_multiplier"))
        p["asset_turnover"] = _f(m.get("asset_turnover"))
        p["ar_days"] = _f(m.get("ar_days"))
        p["inventory_days"] = _f(m.get("inventory_days"))
        p["revenue_growth"] = _f(m.get("revenue_growth"))
        p["profit_growth"] = _f(m.get("profit_growth"))
        p["ocf_to_revenue"] = _f(m.get("ocf_to_revenue"))
        p["ocf_to_profit"] = _f(m.get("ocf_to_profit"))
        p["current_assets"] = _f(m.get("current_assets_wan"))
        p["current_liabilities"] = _f(m.get("current_liabilities_wan"))
        p["accounts_receivable"] = _f(m.get("accounts_receivable_wan"))
        p["inventory"] = _f(m.get("inventory_wan"))
        p["goodwill"] = _f(m.get("goodwill_wan"))
        p["fixed_assets"] = _f(m.get("fixed_assets_wan"))
        p["fixed_assets_gross"] = _f(m.get("fixed_assets_gross_wan"))
        p["accum_depreciation"] = _f(m.get("accum_depreciation_wan"))
        p["surplus_reserve"] = _f(m.get("surplus_reserve_wan"))
        p["undistributed_profit"] = _f(m.get("undistributed_profit_wan"))
        p["operating_profit"] = _f(m.get("operating_profit_wan"))
        p["finance_expense"] = _f(m.get("finance_expense_wan"))
        p["selling_expense"] = _f(m.get("selling_expense_wan"))
        p["admin_expense"] = _f(m.get("admin_expense_wan"))
        p["rd_expense"] = _f(m.get("rd_expense_wan"))
        p["capex"] = _f(m.get("capex_wan"))
        p["deducted_profit"] = _f(m.get("deducted_profit_wan"))
        p["bvps"] = _f(m.get("bvps"))
        p["period_expense_ratio"] = _f(m.get("period_expense_ratio"))

        # ---- 派生（仅当原始指标缺失时；口径统一在此处，避免各调用点各算一遍） ----
        derived: list[str] = []
        if p["net_margin"] is None and p["revenue"] and p["net_profit"] is not None:
            p["net_margin"] = _pct(p["net_profit"], p["revenue"])
            derived.append("net_margin")
        if p["gross_margin"] is None and p["revenue"] and _f(m.get("operating_cost_wan")):
            p["gross_margin"] = _pct(p["revenue"] - _f(m["operating_cost_wan"]), p["revenue"])
            derived.append("gross_margin")
        if p["roe"] is None and p["net_profit"] is not None and p["equity"]:
            p["roe"] = _pct(p["net_profit"], p["equity"])
            derived.append("roe")
        if p["roa"] is None and p["net_profit"] is not None and p["total_assets"]:
            p["roa"] = _pct(p["net_profit"], p["total_assets"])
            derived.append("roa")
        if p["equity_multiplier"] is None and p["total_assets"] and p["equity"]:
            p["equity_multiplier"] = _r(_div(p["total_assets"], p["equity"]))
            derived.append("equity_multiplier")
        if p["current_ratio"] is None and p["current_assets"] and p["current_liabilities"]:
            p["current_ratio"] = _r(_div(p["current_assets"], p["current_liabilities"]))
            derived.append("current_ratio")
        if p["asset_turnover"] is None and p["revenue"] and p["total_assets"]:
            p["asset_turnover"] = _r(_div(p["revenue"], p["total_assets"]))
            derived.append("asset_turnover")
        if p["ocf_to_profit"] is None and p["ocf"] is not None and p["net_profit"]:
            p["ocf_to_profit"] = _r(_div(p["ocf"], p["net_profit"]))
            derived.append("ocf_to_profit")
        if p["goodwill"] is not None and p["equity"]:
            p["goodwill_ratio"] = _pct(p["goodwill"], p["equity"])
        if p["deducted_profit"] is not None and p["net_profit"]:
            p["deducted_ratio"] = _r(_div(p["deducted_profit"], p["net_profit"]))
        if p["equity"] and p["bvps"]:
            p["shares_wan"] = _r(_div(p["equity"], p["bvps"]))  # 万股（用于 F-Score 第 7 项）
        p["derived"] = derived
        periods.append(p)

    # 同比：优先用源指标，缺失则按上期计算
    for i, p in enumerate(periods):
        if i == 0:
            continue
        prev = periods[i - 1]
        if p["revenue_growth"] is None and p["revenue"] is not None and prev["revenue"]:
            p["revenue_growth"] = _pct(p["revenue"] - prev["revenue"], abs(prev["revenue"]))
        if p["profit_growth"] is None and p["net_profit"] is not None and prev["net_profit"]:
            p["profit_growth"] = _pct(p["net_profit"] - prev["net_profit"], abs(prev["net_profit"]))
    return periods


def _latest(periods: list[dict]) -> dict | None:
    return periods[-1] if periods else None


def _prev(periods: list[dict]) -> dict | None:
    return periods[-2] if len(periods) >= 2 else None


# ---------------------------------------------------------------------------
# 1. 概览 KPI
# ---------------------------------------------------------------------------

KPI_KEYS = [
    "revenue", "net_profit", "deducted_profit", "gross_margin", "net_margin", "roe", "roa",
    "debt_ratio", "ocf", "ocf_to_profit", "revenue_growth", "profit_growth",
    "current_ratio", "ar_days", "inventory_days", "goodwill_ratio",
]


def build_kpi(periods: list[dict]) -> list[dict]:
    cur, prev = _latest(periods), _prev(periods)
    out: list[dict] = []
    for key in KPI_KEYS:
        label, unit, group, higher_better = METRIC_META[key]
        v = _f(cur.get(key)) if cur else None
        pv = _f(prev.get(key)) if prev else None
        yoy = None
        if v is not None and pv is not None and pv != 0:
            yoy = round((v - pv) / abs(pv) * 100, 2)
        trend = "flat"
        if v is not None and pv is not None:
            delta = v - pv
            if abs(delta) < 1e-9:
                trend = "flat"
            else:
                good = (delta > 0) == higher_better
                trend = "up" if good else "down"
        out.append({
            "key": key,
            "label": label,
            "unit": unit,
            "group": group,
            "value": _r(v, 2),
            "prev": _r(pv, 2),
            "yoy": yoy,
            "trend": trend,
            "higher_better": higher_better,
            "available": v is not None,
            "year": cur["year"] if cur else None,
            "note": "" if v is not None else "该期无此指标（数据源未提供或未采集）",
        })
    return out


# ---------------------------------------------------------------------------
# 2. 趋势序列
# ---------------------------------------------------------------------------

def build_trends(periods: list[dict]) -> dict:
    groups: dict[str, dict] = {}
    for key, (label, unit, group, _hb) in METRIC_META.items():
        if key in ("net_profit_total", "goodwill_ratio", "deducted_ratio", "deducted_profit"):
            continue
        points = [{"year": p["year"], "value": _r(_f(p.get(key)), 2)} for p in periods]
        if not any(pt["value"] is not None for pt in points):
            continue
        groups.setdefault(group, {"label": DIM_LABELS.get(group, group), "series": []})
        groups[group]["series"].append({"key": key, "label": label, "unit": unit, "points": points})
    return groups


# ---------------------------------------------------------------------------
# 3. 杜邦分解
# ---------------------------------------------------------------------------

def build_dupont(periods: list[dict]) -> dict:
    rows: list[dict] = []
    for p in periods:
        rev, ta, eq = p["revenue"], p["total_assets"], p["equity"]
        np_ = p["net_profit"]
        margin = _div(np_, rev)
        turnover = _div(rev, ta)
        leverage = _div(ta, eq)
        roe = None
        if margin is not None and turnover is not None and leverage is not None:
            roe = margin * turnover * leverage
        rows.append({
            "year": p["year"],
            "roe": _r(roe * 100 if roe is not None else _f(p.get("roe")), 2),
            "net_margin": _r(margin * 100 if margin is not None else _f(p.get("net_margin")), 2),
            "asset_turnover": _r(turnover, 4),
            "equity_multiplier": _r(leverage, 4),
            "complete": all(x is not None for x in (margin, turnover, leverage)),
        })

    attribution = None
    if len(rows) >= 2 and rows[-1]["complete"] and rows[-2]["complete"]:
        a, b = rows[-2], rows[-1]
        m0, t0, l0 = a["net_margin"] / 100, a["asset_turnover"], a["equity_multiplier"]
        m1, t1, l1 = b["net_margin"] / 100, b["asset_turnover"], b["equity_multiplier"]
        c_margin = (m1 - m0) * t0 * l0 * 100
        c_turnover = m1 * (t1 - t0) * l0 * 100
        c_leverage = m1 * t1 * (l1 - l0) * 100
        attribution = {
            "from_year": a["year"],
            "to_year": b["year"],
            "roe_delta": _r(b["roe"] - a["roe"], 2),
            "items": [
                {"key": "net_margin", "label": "销售净利率", "contrib": _r(c_margin, 2)},
                {"key": "asset_turnover", "label": "总资产周转率", "contrib": _r(c_turnover, 2)},
                {"key": "equity_multiplier", "label": "权益乘数（杠杆）", "contrib": _r(c_leverage, 2)},
            ],
            "note": "按三因素顺序分解，贡献之和 = ROE 变动（单位：百分点）",
        }
    return {
        "formula": "ROE = 销售净利率 × 总资产周转率 × 权益乘数",
        "rows": rows,
        "attribution": attribution,
    }


# ---------------------------------------------------------------------------
# 4. 财务预警模型
# ---------------------------------------------------------------------------

def _comp(value, source: str, label: str = "") -> dict:
    return {"value": _r(value, 4), "source": source, "label": label}


_MARKET_CAP_CACHE: dict[str, tuple[float, float | None]] = {}
_MARKET_CAP_TTL = 1800.0  # 成功/失败都缓存，避免每次分析都触发一次失败的网络请求


def _market_cap_wan(code: str, timeout: float = 2.5) -> float | None:
    """总市值（万元）：东财全市场快照，失败/超时返回 None（不阻塞分析）。

    - 结果（含失败）按代码缓存 30 分钟；
    - 使用非阻塞 shutdown，超时线程自行结束，不拖慢请求。
    """
    if not code:
        return None
    now = time.time()
    cached = _MARKET_CAP_CACHE.get(code)
    if cached and now - cached[0] < _MARKET_CAP_TTL:
        return cached[1]

    def _fetch() -> float | None:
        import akshare as ak

        df = ak.stock_zh_a_spot_em()
        row = df[df["代码"].astype(str).str.zfill(6) == code.zfill(6)]
        if row.empty:
            return None
        v = _f(row.iloc[0].get("总市值"))
        return None if v is None else round(v / 1e4, 2)

    pool = ThreadPoolExecutor(max_workers=1)
    value: float | None = None
    try:
        value = pool.submit(_fetch).result(timeout=timeout)
    except FutureTimeout:
        value = None
    except Exception:  # noqa: BLE001 —— 市值仅影响 Z 的 X4，失败不阻断
        value = None
    finally:
        pool.shutdown(wait=False)
    _MARKET_CAP_CACHE[code] = (now, value)
    return value


def build_altman(p: dict, market_cap: float | None) -> dict:
    ca, cl = p.get("current_assets"), p.get("current_liabilities")
    ta, tl, eq = p.get("total_assets"), p.get("total_liabilities"), p.get("equity")
    rev = p.get("revenue")
    retained = None
    if p.get("surplus_reserve") is not None or p.get("undistributed_profit") is not None:
        retained = (p.get("surplus_reserve") or 0) + (p.get("undistributed_profit") or 0)
    ebit = None
    if p.get("operating_profit") is not None:
        ebit = p["operating_profit"] + (p.get("finance_expense") or 0)

    comps: dict[str, dict] = {
        "X1": _comp(_div((ca - cl) if (ca is not None and cl is not None) else None, ta),
                    "exact" if (ca is not None and cl is not None and ta) else "missing", "营运资金 / 总资产"),
        "X2": _comp(_div(retained, ta), "exact" if (retained is not None and ta) else "missing", "留存收益 / 总资产"),
        "X3": _comp(_div(ebit, ta), "exact" if (ebit is not None and ta) else "missing", "EBIT / 总资产"),
        "X5": _comp(_div(rev, ta), "exact" if (rev is not None and ta) else "missing", "营业收入 / 总资产"),
    }
    missing = [k for k, v in comps.items() if v["source"] == "missing"]

    # Z''-Score（非制造业 / 新兴市场，账面权益口径）：始终尝试
    z2_comps = dict(comps)
    z2_comps["X4"] = _comp(_div(eq, tl), "exact" if (eq is not None and tl) else "missing", "账面净资产 / 总负债")
    z2_missing = [k for k, v in z2_comps.items() if v["source"] == "missing"]
    z2 = None
    if not z2_missing:
        z2 = (6.56 * z2_comps["X1"]["value"] + 3.26 * z2_comps["X2"]["value"]
              + 6.72 * z2_comps["X3"]["value"] + 1.05 * z2_comps["X4"]["value"])
    z2_verdict = _z_verdict(z2, 2.6, 1.1) if z2 is not None else None

    # Z-Score（上市制造业，市值口径）：需要市值
    z = None
    z_verdict = None
    z_comps = dict(comps)
    if market_cap is not None:
        z_comps["X4"] = _comp(_div(market_cap, tl), "exact" if tl else "missing", "股权市值 / 总负债")
    else:
        z_comps["X4"] = _comp(None, "missing", "股权市值 / 总负债（未取到总市值）")
    z_missing = [k for k, v in z_comps.items() if v["source"] == "missing"]
    if not z_missing:
        z = (1.2 * z_comps["X1"]["value"] + 1.4 * z_comps["X2"]["value"]
             + 3.3 * z_comps["X3"]["value"] + 0.6 * z_comps["X4"]["value"]
             + 1.0 * z_comps["X5"]["value"])
        z_verdict = _z_verdict(z, 2.99, 1.81)

    return {
        "key": "altman",
        "name": "Altman Z-Score 财务困境预警",
        "period": p["year"],
        "z": {
            "score": _r(z, 3), "verdict": z_verdict, "available": z is not None,
            "basis": "股权市值 / 总负债（上市制造业口径）",
            "thresholds": "Z > 2.99 安全 · 1.81 ~ 2.99 灰色 · Z < 1.81 困境",
            "components": z_comps,
            "missing": [f"{k}（{z_comps[k]['label']}）" for k in z_missing],
            "note": "" if z is not None else "缺少市值或绝对值科目，无法计算 Z；可参考 Z''-Score",
        },
        "z2": {
            "score": _r(z2, 3), "verdict": z2_verdict, "available": z2 is not None,
            "basis": "账面净资产 / 总负债（非制造业 / 新兴市场口径）",
            "thresholds": "Z'' > 2.6 安全 · 1.1 ~ 2.6 灰色 · Z'' < 1.1 困境",
            "components": z2_comps,
            "missing": [f"{k}（{z2_comps[k]['label']}）" for k in z2_missing],
            "note": "" if z2 is not None else "缺少绝对值科目，无法计算 Z''",
        },
    }


def _z_verdict(score: float | None, safe: float, distress: float) -> str | None:
    if score is None:
        return None
    if score > safe:
        return "安全区"
    if score >= distress:
        return "灰色区"
    return "困境区"


def build_piotroski(periods: list[dict]) -> dict:
    """Piotroski F-Score（9 项，需要连续两期）。"""
    if len(periods) < 2:
        return {"key": "piotroski", "name": "Piotroski F-Score", "available": False,
                "reason": "需要连续两年财报", "signals": [], "score": None, "max_score": 9}
    cur, prev = periods[-1], periods[-2]

    def roa(p):
        return _div(p.get("net_profit"), p.get("total_assets"))

    def cfo_ta(p):
        return _div(p.get("ocf"), p.get("total_assets"))

    signals: list[dict] = []

    def add(name: str, ok, detail: str, group: str) -> None:
        signals.append({
            "name": name, "group": group,
            "pass": None if ok is None else bool(ok),
            "detail": detail,
        })

    r_cur, r_prev = roa(cur), roa(prev)
    add("ROA 为正", None if r_cur is None else r_cur > 0, f"ROA = {_r(r_cur * 100, 2)}%" if r_cur is not None else "缺净利润/总资产", "盈利")
    add("经营现金流为正", None if cur.get("ocf") is None else cur["ocf"] > 0,
        f"经营现金流 = {_r(cur.get('ocf'), 0)} 万元" if cur.get("ocf") is not None else "缺经营现金流", "盈利")
    add("ROA 同比改善", None if (r_cur is None or r_prev is None) else r_cur > r_prev,
        f"{_r(r_prev * 100, 2)}% → {_r(r_cur * 100, 2)}%" if (r_cur is not None and r_prev is not None) else "缺两年 ROA", "盈利")
    c_cur = cfo_ta(cur)
    add("经营现金流优于 ROA（应计质量）", None if (c_cur is None or r_cur is None) else c_cur > r_cur,
        f"CFO/TA = {_r(c_cur * 100, 2)}% vs ROA = {_r(r_cur * 100, 2)}%" if (c_cur is not None and r_cur is not None) else "缺经营现金流/总资产", "盈利")

    d_cur, d_prev = _f(cur.get("debt_ratio")), _f(prev.get("debt_ratio"))
    add("杠杆率下降", None if (d_cur is None or d_prev is None) else d_cur < d_prev,
        f"资产负债率 {d_prev}% → {d_cur}%" if (d_cur is not None and d_prev is not None) else "缺资产负债率", "偿债")
    cr_cur, cr_prev = _f(cur.get("current_ratio")), _f(prev.get("current_ratio"))
    add("流动比率上升", None if (cr_cur is None or cr_prev is None) else cr_cur > cr_prev,
        f"流动比率 {cr_prev} → {cr_cur}" if (cr_cur is not None and cr_prev is not None) else "缺流动比率", "偿债")
    s_cur, s_prev = _f(cur.get("shares_wan")), _f(prev.get("shares_wan"))
    add("未增发股本", None if (s_cur is None or s_prev is None) else s_cur <= s_prev * 1.01,
        f"股本 {_r(s_prev, 0)} → {_r(s_cur, 0)} 万股" if (s_cur is not None and s_prev is not None) else "缺每股净资产/净资产，无法推算股本", "偿债")
    g_cur, g_prev = _f(cur.get("gross_margin")), _f(prev.get("gross_margin"))
    add("毛利率上升", None if (g_cur is None or g_prev is None) else g_cur > g_prev,
        f"毛利率 {g_prev}% → {g_cur}%" if (g_cur is not None and g_prev is not None) else "缺毛利率", "效率")
    t_cur, t_prev = _f(cur.get("asset_turnover")), _f(prev.get("asset_turnover"))
    add("总资产周转率上升", None if (t_cur is None or t_prev is None) else t_cur > t_prev,
        f"周转率 {t_prev} → {t_cur}" if (t_cur is not None and t_prev is not None) else "缺总资产周转率", "效率")

    scored = [s for s in signals if s["pass"] is not None]
    score = sum(1 for s in scored if s["pass"]) if scored else None
    max_score = len(scored)
    verdict = None
    if score is not None and max_score == 9:
        verdict = "基本面强（≥7）" if score >= 7 else ("基本面中等（4~6）" if score >= 4 else "基本面弱（≤3）")
    note = "" if max_score == 9 else f"9 项中 {9 - max_score} 项因数据缺失未评分，得分为可评分项之和"
    # F-Score 衡量的是同比改善方向，不衡量盈利的绝对水平，低 ROA 下的高分需加注
    if r_cur is not None and r_cur < 0.02:
        note = (note + "；" if note else "") + f"注意：F-Score 衡量同比改善方向，当前 ROA 仅 {_r(r_cur * 100, 2)}%，绝对盈利水平仍很低"
    return {
        "key": "piotroski",
        "name": "Piotroski F-Score",
        "period": cur["year"],
        "available": score is not None,
        "score": score,
        "max_score": max_score,
        "full_score": 9,
        "verdict": verdict,
        "complete": max_score == 9,
        "signals": signals,
        "note": note,
    }


def build_beneish(periods: list[dict]) -> dict:
    """Beneish M-Score（8 项指数，> -1.78 提示盈余操纵嫌疑）。"""
    if len(periods) < 2:
        return {"key": "beneish", "name": "Beneish M-Score", "available": False,
                "reason": "需要连续两年财报", "indices": [], "score": None}
    cur, prev = periods[-1], periods[-2]

    idx: list[dict] = []

    def add(key: str, label: str, value, source: str, detail: str) -> None:
        idx.append({"key": key, "label": label, "value": _r(value, 4), "source": source, "detail": detail})

    # DSRI 应收账款指数
    dsri = None
    if cur.get("accounts_receivable") and cur.get("revenue") and prev.get("accounts_receivable") and prev.get("revenue"):
        a = cur["accounts_receivable"] / cur["revenue"]
        b = prev["accounts_receivable"] / prev["revenue"]
        dsri = _div(a, b)
        add("DSRI", "应收账款指数", dsri, "exact", "应收账款/营业收入 的同比变化")
    else:
        add("DSRI", "应收账款指数", None, "missing", "缺应收账款或营业收入")

    # GMI 毛利率指数
    gmi = None
    gm_c, gm_p = _f(cur.get("gross_margin")), _f(prev.get("gross_margin"))
    if gm_c and gm_p:
        gmi = gm_p / gm_c
        add("GMI", "毛利率指数", gmi, "exact", f"毛利率 {gm_p}% → {gm_c}%")
    else:
        add("GMI", "毛利率指数", None, "missing", "缺毛利率")

    # AQI 资产质量指数
    aqi = None
    if cur.get("current_assets") and cur.get("fixed_assets") and cur.get("total_assets") \
            and prev.get("current_assets") and prev.get("fixed_assets") and prev.get("total_assets"):
        r_c = 1 - (cur["current_assets"] + cur["fixed_assets"]) / cur["total_assets"]
        r_p = 1 - (prev["current_assets"] + prev["fixed_assets"]) / prev["total_assets"]
        aqi = _div(r_c, r_p)
        add("AQI", "资产质量指数", aqi, "exact", "非流动硬资产占比的同比变化")
    else:
        add("AQI", "资产质量指数", None, "missing", "缺流动资产/固定资产/总资产")

    # SGI 销售增长指数
    sgi = None
    if cur.get("revenue") and prev.get("revenue"):
        sgi = _div(cur["revenue"], prev["revenue"])
        add("SGI", "销售增长指数", sgi, "exact", f"营业收入 {prev['revenue']} → {cur['revenue']} 万元")
    else:
        add("SGI", "销售增长指数", None, "missing", "缺营业收入")

    # DEPI 折旧率指数（用累计折旧增额近似当期折旧）
    depi = None
    if cur.get("accum_depreciation") is not None and prev.get("accum_depreciation") is not None \
            and cur.get("fixed_assets_gross") and prev.get("fixed_assets_gross"):
        dep_c = max(cur["accum_depreciation"] - prev["accum_depreciation"], 0)
        dep_p = max(prev["accum_depreciation"], 0) * 0.1  # 上期折旧以上期累计折旧的 10% 近似
        rate_c = _div(dep_c, dep_c + cur["fixed_assets_gross"])
        rate_p = _div(dep_p, dep_p + prev["fixed_assets_gross"])
        depi = _div(rate_p, rate_c)
        add("DEPI", "折旧率指数", depi, "approx", "当期折旧用累计折旧增额近似，上期折旧按累计折旧 10% 近似")
    else:
        add("DEPI", "折旧率指数", None, "missing", "缺累计折旧/固定资产原值")

    # SGAI 销售管理费用指数
    sgai = None
    sga_c = (cur.get("selling_expense") or 0) + (cur.get("admin_expense") or 0) if cur.get("selling_expense") is not None or cur.get("admin_expense") is not None else None
    sga_p = (prev.get("selling_expense") or 0) + (prev.get("admin_expense") or 0) if prev.get("selling_expense") is not None or prev.get("admin_expense") is not None else None
    if sga_c is not None and sga_p is not None and cur.get("revenue") and prev.get("revenue"):
        sgai = _div(sga_c / cur["revenue"], sga_p / prev["revenue"])
        add("SGAI", "销售管理费用指数", sgai, "exact", "（销售+管理）费用率的同比变化")
    else:
        add("SGAI", "销售管理费用指数", None, "missing", "缺销售/管理费用")

    # LVGI 杠杆指数
    lvgi = None
    lv_c = _div(cur.get("total_liabilities"), cur.get("total_assets"))
    lv_p = _div(prev.get("total_liabilities"), prev.get("total_assets"))
    if lv_c is not None and lv_p is not None:
        lvgi = _div(lv_c, lv_p)
        add("LVGI", "杠杆指数", lvgi, "exact", "资产负债率的同比变化")
    else:
        add("LVGI", "杠杆指数", None, "missing", "缺总负债/总资产")

    # TATA 总应计
    tata = None
    if cur.get("net_profit") is not None and cur.get("ocf") is not None and cur.get("total_assets"):
        tata = _div(cur["net_profit"] - cur["ocf"], cur["total_assets"])
        add("TATA", "总应计项目", tata, "exact", "（净利润 − 经营现金流）/ 总资产")
    else:
        add("TATA", "总应计项目", None, "missing", "缺净利润/经营现金流/总资产")

    values = {i["key"]: i["value"] for i in idx}
    missing = [i["label"] for i in idx if i["value"] is None]
    score = None
    if not missing:
        score = (-4.84 + 0.920 * values["DSRI"] + 0.528 * values["GMI"] + 0.404 * values["AQI"]
                 + 0.892 * values["SGI"] + 0.115 * values["DEPI"] - 0.172 * values["SGAI"]
                 + 4.679 * values["TATA"] - 0.327 * values["LVGI"])
    verdict = None
    if score is not None:
        verdict = "存在盈余操纵嫌疑" if score > -1.78 else "未见明显操纵迹象"
    approx = [i["label"] for i in idx if i["source"] == "approx"]
    return {
        "key": "beneish",
        "name": "Beneish M-Score 盈余操纵识别",
        "period": cur["year"],
        "available": score is not None,
        "score": _r(score, 3),
        "thresholds": "M > -1.78 提示盈余操纵嫌疑（Beneish 1999 阈值）",
        "verdict": verdict,
        "indices": idx,
        "missing": missing,
        "approx": approx,
        "note": ("含近似项：" + "、".join(approx) + "；结论请结合审计意见判断") if approx else "",
    }


# ---------------------------------------------------------------------------
# 5. 同业对标
# ---------------------------------------------------------------------------

PEER_METRICS = ["revenue", "revenue_growth", "gross_margin", "net_margin", "roe",
                "debt_ratio", "asset_turnover", "current_ratio", "ocf_to_profit"]


def _percentile(values: list[float], v: float, higher_better: bool) -> float | None:
    if not values or v is None:
        return None
    below = sum(1 for x in values if x < v)
    equal = sum(1 for x in values if x == v)
    pct = (below + 0.5 * equal) / len(values) * 100
    return round(pct if higher_better else 100 - pct, 1)


def build_peers(db: DbSession, ent: Enterprise, years: int = 5, limit: int = 6) -> dict:
    """同行业对标：默认取同行业企业（不足时补充其他企业）。"""
    q = db.query(Enterprise).filter(Enterprise.id != ent.id)
    peers = q.filter(Enterprise.industry == ent.industry).limit(limit).all() if ent.industry else []
    if len(peers) < 2:
        extra = q.limit(limit).all()
        seen = {p.id for p in peers}
        peers = peers + [x for x in extra if x.id not in seen][: max(0, limit - len(peers))]

    rows: list[dict] = []
    for e in [ent, *peers]:
        ps = load_periods(db, e.id, years)
        cur = _latest(ps)
        if cur is None:
            continue
        rows.append({
            "enterprise_id": e.id,
            "name": e.name,
            "industry": e.industry or "",
            "is_self": e.id == ent.id,
            "year": cur["year"],
            "metrics": {k: _r(_f(cur.get(k)), 2) for k in PEER_METRICS},
        })

    for key in PEER_METRICS:
        label, unit, _g, higher_better = METRIC_META[key]
        vals = [r["metrics"][key] for r in rows if r["metrics"].get(key) is not None]
        for r in rows:
            v = r["metrics"].get(key)
            r.setdefault("percentiles", {})[key] = _percentile(vals, v, higher_better) if v is not None else None

    self_row = next((r for r in rows if r["is_self"]), None)
    return {
        "industry": ent.industry or "",
        "rows": rows,
        "self": self_row,
        "metrics": [
            {"key": k, "label": METRIC_META[k][0], "unit": METRIC_META[k][1],
             "higher_better": METRIC_META[k][3]}
            for k in PEER_METRICS
        ],
        "note": "分位数按可比企业集合计算（含本企业）；" + ("同行业企业不足 2 家，已补充其他企业" if len(peers) < 2 else f"同行业可比企业 {len(peers)} 家"),
    }


# ---------------------------------------------------------------------------
# 6. 异常勾稽
# ---------------------------------------------------------------------------

def build_anomalies(periods: list[dict], peer_median: dict | None = None) -> list[dict]:
    out: list[dict] = []
    cur = _latest(periods)
    prev = _prev(periods)
    if cur is None:
        return out

    def add(code: str, level: str, title: str, detail: str, evidence: dict) -> None:
        out.append({"code": code, "level": level, "title": title, "detail": detail, "evidence": evidence})

    # 1. 有利润无现金
    if cur.get("net_profit") is not None and cur.get("ocf") is not None \
            and cur["net_profit"] > 0 and cur["ocf"] < 0:
        add("OCF_NEGATIVE", "high", "净利润为正但经营现金流为负",
            f"{cur['year']} 年归母净利润 {_r(cur['net_profit'], 0)} 万元，经营活动现金流 {_r(cur['ocf'], 0)} 万元，利润未转化为现金。",
            {"year": cur["year"], "net_profit": cur["net_profit"], "ocf": cur["ocf"]})

    # 2. 现金含量过低
    ocfp = _f(cur.get("ocf_to_profit"))
    if ocfp is not None and 0 <= ocfp < 0.5 and (cur.get("net_profit") or 0) > 0:
        add("LOW_CASH_CONTENT", "medium", "现金含量偏低",
            f"经营现金流/净利润 = {ocfp}（低于 0.5），盈利质量偏弱。",
            {"year": cur["year"], "ocf_to_profit": ocfp})

    # 3. 营收与应收背离
    if prev and cur.get("accounts_receivable") and prev.get("accounts_receivable") and cur.get("revenue") and prev.get("revenue"):
        rev_g = _pct(cur["revenue"] - prev["revenue"], abs(prev["revenue"]))
        ar_g = _pct(cur["accounts_receivable"] - prev["accounts_receivable"], abs(prev["accounts_receivable"]))
        if rev_g is not None and ar_g is not None and rev_g > 20 and ar_g > rev_g + 20:
            add("AR_DIVERGENCE", "high", "应收账款增速显著高于营收",
                f"营收同比 {_r(rev_g, 1)}%，应收账款同比 {_r(ar_g, 1)}%，收入含金量需核实（是否存在放宽信用或提前确认收入）。",
                {"year": cur["year"], "revenue_growth": rev_g, "ar_growth": ar_g})

    # 4. 毛利率显著高于同业
    gm = _f(cur.get("gross_margin"))
    if gm is not None and peer_median and peer_median.get("gross_margin") is not None \
            and gm - peer_median["gross_margin"] > 20:
        add("MARGIN_ABOVE_PEERS", "medium", "毛利率显著高于同业中位数",
            f"毛利率 {gm}%，同业中位数 {peer_median['gross_margin']}%，差异超过 20 个百分点，需核实成本口径与关联交易。",
            {"year": cur["year"], "gross_margin": gm, "peer_median": peer_median["gross_margin"]})

    # 5. 杠杆快速上升
    if prev:
        d1, d0 = _f(cur.get("debt_ratio")), _f(prev.get("debt_ratio"))
        if d1 is not None and d0 is not None and d1 - d0 >= 10:
            add("DEBT_JUMP", "high", "资产负债率一年内大幅上升",
                f"资产负债率 {d0}% → {d1}%，上升 {_r(d1 - d0, 1)} 个百分点，偿债压力快速累积。",
                {"from_year": prev["year"], "to_year": cur["year"], "from": d0, "to": d1})

    # 6. 存货周转恶化
    if len(periods) >= 3:
        a, b, c = periods[-3], periods[-2], periods[-1]
        i0, i1, i2 = _f(a.get("inventory_days")), _f(b.get("inventory_days")), _f(c.get("inventory_days"))
        if None not in (i0, i1, i2) and i1 > i0 and i2 > i1 and i0 > 0 and (i2 - i0) / i0 > 0.3:
            add("INVENTORY_WORSEN", "medium", "存货周转天数连续两期恶化",
                f"存货周转天数 {i0} → {i1} → {i2} 天，累计上升 {_r((i2 - i0) / i0 * 100, 1)}%，存在积压或跌价风险。",
                {"years": [a["year"], b["year"], c["year"]], "inventory_days": [i0, i1, i2]})

    # 7. 商誉占比过高
    gr = _f(cur.get("goodwill_ratio"))
    if gr is not None and gr > 30:
        add("GOODWILL_HEAVY", "high", "商誉占净资产比例过高",
            f"商誉/净资产 = {_r(gr, 1)}%，超过 30%，存在减值冲击净资产的风险。",
            {"year": cur["year"], "goodwill_ratio": gr})

    # 8. 扣非利润占比低
    dr = _f(cur.get("deducted_ratio"))
    if dr is not None and dr < 0.5:
        dp = cur.get("deducted_profit")
        if dr < 0:
            detail = (f"扣非净利润为负（{_r(dp, 0)} 万元），而净利润为正（{_r(cur.get('net_profit'), 0)} 万元），"
                      f"盈利完全依赖非经常性损益（如资产处置、重整收益、政府补助）。")
        else:
            detail = f"扣非净利润/净利润 = {_r(dr, 2)}，利润较大程度依赖非经常性损益。"
        add("LOW_DEDUCTED", "medium", "扣非净利润占比偏低", detail,
            {"year": cur["year"], "deducted_ratio": dr, "deducted_profit_wan": dp})

    # 9. 利润与营收增速剪刀差
    if cur.get("revenue_growth") is not None and cur.get("profit_growth") is not None \
            and cur["revenue_growth"] > 0 and cur["profit_growth"] - cur["revenue_growth"] > 50:
        add("GROWTH_SCISSOR", "medium", "净利润增速远超营收增速",
            f"营收同比 {_r(cur['revenue_growth'], 1)}%，净利润同比 {_r(cur['profit_growth'], 1)}%，利润增长缺乏收入支撑。",
            {"year": cur["year"], "revenue_growth": cur["revenue_growth"], "profit_growth": cur["profit_growth"]})

    # 10. 应收周转恶化
    if len(periods) >= 3:
        a, b, c = periods[-3], periods[-2], periods[-1]
        a0, a1, a2 = _f(a.get("ar_days")), _f(b.get("ar_days")), _f(c.get("ar_days"))
        if None not in (a0, a1, a2) and a1 > a0 and a2 > a1 and a0 > 0 and (a2 - a0) / a0 > 0.3:
            add("AR_WORSEN", "medium", "应收账款周转天数持续恶化",
                f"应收账款周转天数 {a0} → {a1} → {a2} 天，回款效率下降。",
                {"years": [a["year"], b["year"], c["year"]], "ar_days": [a0, a1, a2]})

    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(out, key=lambda x: order.get(x["level"], 3))


def _peer_median(peer: dict | None) -> dict:
    if not peer:
        return {}
    out: dict = {}
    for key in PEER_METRICS:
        vals = [r["metrics"][key] for r in peer.get("rows", []) if r["metrics"].get(key) is not None]
        if vals:
            vals = sorted(vals)
            n = len(vals)
            out[key] = round(vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2, 2)
    return out


# ---------------------------------------------------------------------------
# 组装：完整分析结果
# ---------------------------------------------------------------------------

def analysis(db: DbSession, enterprise_id: int, years: int = 5, with_peers: bool = True) -> dict:
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        return {"error": f"企业不存在: {enterprise_id}"}

    periods = load_periods(db, enterprise_id, years)
    data_status = _load_json(ent.data_status_json)

    if not periods:
        return {
            "enterprise": {"id": ent.id, "name": ent.name, "industry": ent.industry, "stock_code": ent.stock_code},
            "available": False,
            "reason": "无财务数据（未采集或非上市企业）",
            "data_status": data_status.get("finance", "never"),
            "kpi": [], "trends": {}, "dupont": {"rows": [], "attribution": None},
            "models": {}, "peers": None, "anomalies": [],
            "data_quality": {"years": 0, "periods": [], "notes": ["请先执行数据源刷新（POST /api/enterprise/{id}/refresh）"]},
        }

    peer = build_peers(db, ent, years) if with_peers else None
    median = _peer_median(peer)
    cur = _latest(periods)

    # Altman 需要市值（可选）；仅在上市且有代码时尝试
    market_cap = _market_cap_wan(ent.stock_code) if ent.stock_code else None

    models = {
        "altman": build_altman(cur, market_cap),
        "piotroski": build_piotroski(periods),
        "beneish": build_beneish(periods),
    }

    missing_keys = [k for k in METRIC_META if all(_f(p.get(k)) is None for p in periods)]
    notes: list[str] = []
    if len(periods) < 2:
        notes.append("仅有一期财报，同比与 F/M 模型不可用")
    if market_cap is None and ent.stock_code:
        notes.append("未取到总市值，Altman Z 使用 Z'' 口径（账面净资产）")
    if not ent.industry:
        notes.append("企业未标注行业，同业对标为全库可比")

    return {
        "enterprise": {
            "id": ent.id, "name": ent.name, "industry": ent.industry,
            "stock_code": ent.stock_code, "legal_rep": ent.legal_rep,
            "reg_date": ent.reg_date, "data_note": ent.data_note,
        },
        "available": True,
        "latest_year": cur["year"],
        "data_status": data_status.get("finance", "never"),
        "kpi": build_kpi(periods),
        "trends": build_trends(periods),
        "dupont": build_dupont(periods),
        "models": models,
        "peers": peer,
        "peer_median": median,
        "anomalies": build_anomalies(periods, median),
        "market_cap_wan": market_cap,
        "data_quality": {
            "years": len(periods),
            "periods": [{"year": p["year"], "report_type": p["report_type"], "source": p["source"],
                         "derived": p.get("derived", [])} for p in periods],
            "missing_metrics": missing_keys,
            "notes": notes,
        },
    }


def overview(db: DbSession, years: int = 5) -> dict:
    """全库财务概览：供前端选择器与横向筛选。"""
    ents = db.query(Enterprise).order_by(Enterprise.name.asc()).all()
    items: list[dict] = []
    for e in ents:
        periods = load_periods(db, e.id, years)
        cur = _latest(periods)
        items.append({
            "enterprise_id": e.id,
            "name": e.name,
            "industry": e.industry or "",
            "stock_code": e.stock_code or "",
            "has_finance": cur is not None,
            "years": len(periods),
            "latest_year": cur["year"] if cur else None,
            "revenue": _r(_f(cur.get("revenue")) if cur else None, 2),
            "net_profit": _r(_f(cur.get("net_profit")) if cur else None, 2),
            "revenue_growth": _r(_f(cur.get("revenue_growth")) if cur else None, 2),
            "gross_margin": _r(_f(cur.get("gross_margin")) if cur else None, 2),
            "net_margin": _r(_f(cur.get("net_margin")) if cur else None, 2),
            "roe": _r(_f(cur.get("roe")) if cur else None, 2),
            "debt_ratio": _r(_f(cur.get("debt_ratio")) if cur else None, 2),
        })
    return {"total": len(items), "items": items}


# ---------------------------------------------------------------------------
# 报告（确定性 Markdown；叙述性解读由 Agent 工具完成）
# ---------------------------------------------------------------------------

def report_markdown(db: DbSession, enterprise_id: int, years: int = 5) -> str:
    a = analysis(db, enterprise_id, years)
    if a.get("error"):
        return f"# 金融分析报告\n\n{a['error']}\n"
    ent = a["enterprise"]
    if not a.get("available"):
        return (f"# {ent['name']} 金融分析报告\n\n"
                f"**结论**：无财务数据（{a.get('reason')}）。\n\n"
                f"数据状态：`{a.get('data_status')}`。请先刷新数据源或补充人工财报。\n")

    lines: list[str] = [f"# {ent['name']} 金融分析报告", ""]
    lines.append(f"- 行业：{ent.get('industry') or '—'}　股票代码：{ent.get('stock_code') or '—'}")
    lines.append(f"- 分析期间：{a['data_quality']['periods'][0]['year']}–{a['latest_year']}（{a['data_quality']['years']} 期年报）")
    lines.append(f"- 数据来源：{'；'.join(sorted({p['source'] for p in a['data_quality']['periods'] if p['source']})) or '—'}")
    lines.append("")

    lines.append("## 一、关键指标概览")
    lines.append("")
    lines.append("| 指标 | " + " | ".join(f"{a['latest_year']}" for _ in [0]) + " | 上期 | 同比 |")
    lines.append("|---|---|---|---|")
    for k in a["kpi"]:
        if not k["available"]:
            continue
        yoy = f"{k['yoy']}%" if k["yoy"] is not None else "—"
        prev = f"{k['prev']}" if k["prev"] is not None else "—"
        lines.append(f"| {k['label']}（{k['unit']}） | {k['value']} | {prev} | {yoy} |")
    lines.append("")

    d = a["dupont"]
    lines.append("## 二、杜邦分解")
    lines.append("")
    lines.append(f"`{d['formula']}`")
    lines.append("")
    lines.append("| 年度 | ROE(%) | 销售净利率(%) | 总资产周转率 | 权益乘数 |")
    lines.append("|---|---|---|---|---|")
    for r in d["rows"]:
        lines.append(f"| {r['year']} | {r['roe'] if r['roe'] is not None else '—'} | "
                     f"{r['net_margin'] if r['net_margin'] is not None else '—'} | "
                     f"{r['asset_turnover'] if r['asset_turnover'] is not None else '—'} | "
                     f"{r['equity_multiplier'] if r['equity_multiplier'] is not None else '—'} |")
    if d.get("attribution"):
        at = d["attribution"]
        lines.append("")
        lines.append(f"**{at['from_year']} → {at['to_year']} ROE 变动 {at['roe_delta']} 个百分点**，归因：")
        for it in at["items"]:
            lines.append(f"- {it['label']}：{it['contrib']} 个百分点")
    lines.append("")

    lines.append("## 三、财务预警模型")
    lines.append("")
    m = a["models"]
    z2 = m["altman"]["z2"]
    lines.append(f"- **Altman Z''-Score**：{z2['score'] if z2['available'] else '不可计算'}"
                 + (f"（{z2['verdict']}，{z2['basis']}）" if z2["available"] else f"，缺 {', '.join(z2['missing'])}"))
    z = m["altman"]["z"]
    lines.append(f"- **Altman Z-Score**：{z['score'] if z['available'] else '不可计算'}"
                 + (f"（{z['verdict']}，{z['basis']}）" if z["available"] else f"，缺 {', '.join(z['missing'])}"))
    f = m["piotroski"]
    lines.append(f"- **Piotroski F-Score**：{f['score']}/{f['max_score']}"
                 + (f"（{f['verdict']}）" if f.get("verdict") else "") + (f"　{f['note']}" if f.get("note") else ""))
    b = m["beneish"]
    lines.append(f"- **Beneish M-Score**：{b['score'] if b['available'] else '不可计算'}"
                 + (f"（{b['verdict']}）" if b["available"] else f"，缺 {', '.join(b['missing'])}"))
    if b.get("note"):
        lines.append(f"  - {b['note']}")
    lines.append("")

    lines.append("## 四、异常勾稽")
    lines.append("")
    if a["anomalies"]:
        for an in a["anomalies"]:
            lines.append(f"- **[{an['level']}] {an['title']}**：{an['detail']}")
    else:
        lines.append("- 未触发异常规则（在现有数据范围内）。")
    lines.append("")

    if a.get("peers") and a["peers"].get("self"):
        lines.append("## 五、同业对标")
        lines.append("")
        metrics = a["peers"]["metrics"]
        lines.append("| 企业 | " + " | ".join(f"{mm['label']}" for mm in metrics) + " |")
        lines.append("|" + "---|" * (len(metrics) + 1))
        for r in a["peers"]["rows"]:
            cells = [("**" + r["name"] + "**") if r["is_self"] else r["name"]]
            for mm in metrics:
                v = r["metrics"].get(mm["key"])
                cells.append(f"{v}{mm['unit']}" if v is not None else "—")
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")

    lines.append("## 六、数据质量说明")
    lines.append("")
    lines.append(f"- 覆盖期数：{a['data_quality']['years']} 期年报")
    if a["data_quality"]["missing_metrics"]:
        lines.append(f"- 全期缺失指标：{', '.join(a['data_quality']['missing_metrics'])}")
    for n in a["data_quality"]["notes"]:
        lines.append(f"- {n}")
    lines.append("")
    lines.append("> 数据来自公开信源，模型结果为规则化测算，不构成投资建议。")
    return "\n".join(lines)

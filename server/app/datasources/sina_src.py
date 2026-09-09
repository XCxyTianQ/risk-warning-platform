"""新浪财经数据源（AkShare 封装）：财务三表，作为东财财务的备用信源与模型输入补充。

用途：
1. 东财 `stock_financial_abstract` 失败或字段缺失时降级；
2. 提供**绝对值科目**（流动资产、流动负债、应收账款、存货、固定资产、累计折旧、
   盈余公积、未分配利润、营业利润、财务费用等），供金融分析模块的
   Altman Z-Score / Piotroski F-Score / Beneish M-Score 计算。

单位：元 → 万元。
"""

import json

from app.datasources.base import FetchResult, NormalizedRecord
from app.datasources.codes import market_prefix

# (metrics_json 键, 报表, 科目名)  绝对科目：元 → 万元
BALANCE_ITEMS = [
    ("current_assets_wan", "流动资产合计"),
    ("current_liabilities_wan", "流动负债合计"),
    ("accounts_receivable_wan", "应收账款"),
    ("inventory_wan", "存货"),
    ("goodwill_wan", "商誉"),
    ("fixed_assets_wan", "固定资产净额"),
    ("fixed_assets_gross_wan", "固定资产原值"),
    ("accum_depreciation_wan", "累计折旧"),
    ("surplus_reserve_wan", "盈余公积"),
    ("undistributed_profit_wan", "未分配利润"),
    ("equity_parent_wan", "归属于母公司股东权益合计"),
    ("total_assets_wan", "资产总计"),
    ("total_liabilities_wan", "负债合计"),
]
INCOME_ITEMS = [
    ("revenue_wan", "营业总收入"),
    ("operating_cost_wan", "营业成本"),
    ("operating_profit_wan", "营业利润"),
    ("total_profit_wan", "利润总额"),
    ("income_tax_wan", "所得税费用"),
    ("net_profit_total_wan", "净利润"),
    ("net_profit_wan", "归属于母公司所有者的净利润"),
    ("finance_expense_wan", "财务费用"),
    ("selling_expense_wan", "销售费用"),
    ("admin_expense_wan", "管理费用"),
    ("rd_expense_wan", "研发费用"),
]
CASHFLOW_ITEMS = [
    ("ocf_wan", "经营活动产生的现金流量净额"),
    ("capex_wan", "购建固定资产、无形资产和其他长期资产所支付的现金"),
]


class SinaSource:
    name = "akshare:sina"
    dimensions = ["finance"]

    def fetch_finance(self, enterprise) -> FetchResult:
        code = (enterprise.stock_code or "").strip()
        if not code:
            return FetchResult("finance", self.name, gap="无股票代码")
        try:
            import akshare as ak

            prefix = market_prefix(code)
            bs = ak.stock_financial_report_sina(stock=prefix, symbol="资产负债表")
            ps = ak.stock_financial_report_sina(stock=prefix, symbol="利润表")
            cf = ak.stock_financial_report_sina(stock=prefix, symbol="现金流量表")
        except Exception as exc:  # noqa: BLE001
            return FetchResult("finance", self.name, error=f"{type(exc).__name__}: {exc}")

        def annual_rows(df) -> dict[str, dict]:
            out: dict[str, dict] = {}
            if df is None or df.empty:
                return out
            date_col = "报告日" if "报告日" in df.columns else df.columns[0]
            for _, row in df.iterrows():
                period = str(row.get(date_col) or "")
                if not period.endswith("1231"):
                    continue
                year = period[:4]
                if year in out:
                    continue
                out[year] = row
            return out

        def collect(row, items: list[tuple[str, str]], metrics: dict) -> None:
            for key, col in items:
                v = _num(row.get(col)) if row is not None else None
                if v is not None:
                    metrics[key] = round(v / 1e4, 2)

        assets = annual_rows(bs)
        profits = annual_rows(ps)
        cashflows = annual_rows(cf)

        records: list[NormalizedRecord] = []
        for year, a in list(assets.items())[:5]:
            p = profits.get(year)
            c = cashflows.get(year)
            total_assets = _num(a.get("资产总计"))
            total_liabilities = _num(a.get("负债合计"))
            debt_ratio = (
                round(total_liabilities / total_assets * 100, 2)
                if total_assets and total_liabilities is not None else 0.0
            )

            metrics: dict[str, float] = {}
            collect(a, BALANCE_ITEMS, metrics)
            collect(p, INCOME_ITEMS, metrics)
            collect(c, CASHFLOW_ITEMS, metrics)

            revenue = _num(p.get("营业总收入")) if p is not None else None
            net_profit_parent = _num(p.get("归属于母公司所有者的净利润")) if p is not None else None
            net_profit_total = _num(p.get("净利润")) if p is not None else None
            if net_profit_parent is None:
                net_profit_parent = net_profit_total
            # 派生比率（新浪源无现成比率，用三表绝对值计算，供降级时使用）
            if revenue:
                if metrics.get("operating_cost_wan") is not None:
                    metrics.setdefault("gross_margin", round((1 - metrics["operating_cost_wan"] * 1e4 / revenue) * 100, 4))
                if net_profit_parent is not None:
                    metrics.setdefault("net_margin", round(net_profit_parent / revenue * 100, 4))
            equity = _num(a.get("归属于母公司股东权益合计"))
            if equity and net_profit_parent is not None:
                metrics.setdefault("roe", round(net_profit_parent / equity * 100, 4))
            if total_assets and net_profit_parent is not None:
                metrics.setdefault("roa", round(net_profit_parent / total_assets * 100, 4))
            metrics.setdefault("debt_ratio", debt_ratio)
            if total_assets and revenue:
                metrics.setdefault("asset_turnover", round(revenue / total_assets, 6))

            records.append(NormalizedRecord(
                kind="finance",
                external_id=f"{code}-{year}-annual-sina",
                source="akshare:sina_financial_report",
                raw_ref=f"akshare.stock_financial_report_sina({prefix}, 资产负债表/利润表/现金流量表)",
                payload={
                    "year": year,
                    "report_type": "年报",
                    "revenue": round((revenue or 0) / 1e4, 2),
                    "net_profit": round((net_profit_parent or 0) / 1e4, 2),
                    "debt_ratio": debt_ratio,
                    "total_assets": round((total_assets or 0) / 1e4, 2),
                    "total_liabilities": round((total_liabilities or 0) / 1e4, 2),
                    "source": "AkShare/新浪财经（公开财报）",
                    "metrics_json": json.dumps(metrics, ensure_ascii=False),
                },
            ))
        return FetchResult("finance", self.name, records=records)

    def fetch(self, enterprise, dimension: str, since: str | None = None) -> FetchResult:
        if dimension == "finance":
            return self.fetch_finance(enterprise)
        return FetchResult(dimension, self.name, error=f"unsupported dimension: {dimension}")


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


sina_source = SinaSource()

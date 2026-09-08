"""新浪财经数据源（AkShare 封装）：财务三表，作为东财财务的备用信源。

用途：东财 `stock_financial_abstract` 失败或字段缺失时降级；也可用于交叉校验。
"""

from app.datasources.base import FetchResult, NormalizedRecord
from app.datasources.codes import market_prefix


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
        except Exception as exc:  # noqa: BLE001
            return FetchResult("finance", self.name, error=f"{type(exc).__name__}: {exc}")

        def annual_rows(df, cols: list[str]) -> dict[str, dict]:
            out: dict[str, dict] = {}
            date_col = "报告日" if "报告日" in df.columns else df.columns[0]
            for _, row in df.iterrows():
                period = str(row.get(date_col) or "")
                if not period.endswith("1231"):
                    continue
                year = period[:4]
                if year in out:
                    continue
                out[year] = {c: row.get(c) for c in cols if c in df.columns}
            return out

        assets = annual_rows(bs, ["资产总计", "负债合计"])
        profits = annual_rows(ps, ["营业总收入", "净利润"])

        records: list[NormalizedRecord] = []
        for year, a in list(assets.items())[:3]:
            p = profits.get(year, {})
            total_assets = _num(a.get("资产总计"))
            total_liabilities = _num(a.get("负债合计"))
            debt_ratio = (
                round(total_liabilities / total_assets * 100, 2)
                if total_assets and total_liabilities is not None else 0.0
            )
            records.append(NormalizedRecord(
                kind="finance",
                external_id=f"{code}-{year}-annual-sina",
                source="akshare:sina_financial_report",
                raw_ref=f"akshare.stock_financial_report_sina({prefix}, 资产负债表/利润表)",
                payload={
                    "year": year,
                    "report_type": "年报",
                    "revenue": round((_num(p.get("营业总收入")) or 0) / 1e4, 2),
                    "net_profit": round((_num(p.get("净利润")) or 0) / 1e4, 2),
                    "debt_ratio": debt_ratio,
                    "total_assets": round((total_assets or 0) / 1e4, 2),
                    "total_liabilities": round((total_liabilities or 0) / 1e4, 2),
                    "source": "AkShare/新浪财经（公开财报）",
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

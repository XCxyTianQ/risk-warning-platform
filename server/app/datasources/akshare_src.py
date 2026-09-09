"""AkShare 数据源：上市公司财务 / 舆情新闻 / 诉讼统计（免费公开数据）。

映射与单位约定：
- 财务：元 → 万元；只取年度报告期（列名 YYYYMMDD 且以 1231 结尾），最多 5 期
- 财务指标快照：东财财务摘要的比率类指标按原值（百分比）存入 metrics_json
- 舆情：新闻标题/来源/链接/时间；情感用关键词规则（源无情感字段）
- 诉讼：巨潮"公司诉讼"专题统计（按板块拉全市场后按代码过滤），得到诉讼次数/金额
"""

import json
from datetime import date, timedelta

from app.datasources.base import FetchResult, NormalizedRecord

# (metrics_json 键, 东财指标名, 单位)  unit: wan=元→万元；ratio=百分比原值；num=原值
FINANCE_METRICS = [
    ("revenue_wan", "营业总收入", "wan"),
    ("net_profit_wan", "归母净利润", "wan"),
    ("net_profit_total_wan", "净利润", "wan"),
    ("operating_cost_wan", "营业成本", "wan"),
    ("deducted_profit_wan", "扣非净利润", "wan"),
    ("equity_wan", "股东权益合计(净资产)", "wan"),
    ("goodwill_wan", "商誉", "wan"),
    ("ocf_wan", "经营现金流量净额", "wan"),
    ("eps", "基本每股收益", "num"),
    ("bvps", "每股净资产", "num"),
    ("ocfps", "每股经营现金流", "num"),
    ("undistributed_ps", "每股未分配利润", "num"),
    ("surplus_reserve_ps", "每股盈余公积金", "num"),
    ("retained_ps", "每股留存收益", "num"),
    ("revenue_ps", "每股营业总收入", "num"),
    ("ebit_ps", "每股息税前利润", "num"),
    ("roe", "净资产收益率(ROE)", "ratio"),
    ("roa", "总资产报酬率(ROA)", "ratio"),
    ("gross_margin", "毛利率", "ratio"),
    ("net_margin", "销售净利率", "ratio"),
    ("period_expense_ratio", "期间费用率", "ratio"),
    ("debt_ratio", "资产负债率", "ratio"),
    ("ebit_margin", "息税前利润率", "ratio"),
    ("operating_margin", "营业利润率", "ratio"),
    ("roic", "投入资本回报率", "ratio"),
    ("revenue_growth", "营业总收入增长率", "ratio"),
    ("profit_growth", "归属母公司净利润增长率", "ratio"),
    ("ocf_to_revenue", "经营活动净现金/销售收入", "num"),
    ("ocf_to_profit", "经营活动净现金/归属母公司的净利润", "num"),
    ("tax_to_pretax", "所得税/利润总额", "ratio"),
    ("current_ratio", "流动比率", "num"),
    ("quick_ratio", "速动比率", "num"),
    ("equity_multiplier", "权益乘数", "num"),
    ("debt_to_equity", "产权比率", "ratio"),
    ("cash_ratio", "现金比率", "num"),
    ("ar_turnover", "应收账款周转率", "num"),
    ("ar_days", "应收账款周转天数", "num"),
    ("inventory_turnover", "存货周转率", "num"),
    ("inventory_days", "存货周转天数", "num"),
    ("asset_turnover", "总资产周转率", "num"),
    ("asset_days", "总资产周转天数", "num"),
    ("current_asset_turnover", "流动资产周转率", "num"),
    ("ap_turnover", "应付账款周转率", "num"),
]

NEGATIVE_WORDS = (
    "处罚", "罚款", "立案", "调查", "问询", "警示", "违规", "违法", "诉讼", "起诉",
    "被执行", "失信", "冻结", "退市", "亏损", "下滑", "减持", "质押", "风险提示",
    "欠款", "违约", "停牌", "暴跌", "质疑", "争议", "限制", "解禁", "商誉减值",
)
POSITIVE_WORDS = (
    "增长", "盈利", "中标", "获奖", "增持", "回购", "分红", "突破", "合作", "签约",
    "创新高", "上调", "利好", "获得", "通过", "入选", "领先", "投产", "扩产",
)


def classify_sentiment(text: str) -> str:
    neg = sum(1 for w in NEGATIVE_WORDS if w in text)
    pos = sum(1 for w in POSITIVE_WORDS if w in text)
    if neg > pos:
        return "negative"
    if pos > neg:
        return "positive"
    return "neutral"


def _board_of(code: str) -> str:
    if code.startswith("688"):
        return "科创板"
    if code.startswith("300") or code.startswith("301"):
        return "创业板"
    if code.startswith("6"):
        return "沪市"
    return "深市主板"


class AkShareSource:
    name = "akshare"
    dimensions = ["finance", "news", "legal"]

    # ---------- 财务 ----------
    def fetch_finance(self, enterprise) -> FetchResult:
        code = (enterprise.stock_code or "").strip()
        if not code:
            return FetchResult("finance", self.name, gap="无股票代码（非上市企业，需人工数据源）")
        try:
            import akshare as ak

            df = ak.stock_financial_abstract(symbol=code)
        except Exception as exc:  # noqa: BLE001
            return FetchResult("finance", self.name, error=f"{type(exc).__name__}: {exc}")

        def value(indicator: str, col: str) -> float | None:
            """同名指标可能重复出现，取第一个非 NaN 值。"""
            rows = df[df["指标"] == indicator]
            for _, r in rows.iterrows():
                raw = r.get(col)
                try:
                    v = float(raw)
                except (TypeError, ValueError):
                    continue
                if v == v:  # 过滤 NaN
                    return v
            return None

        annual_cols = [c for c in df.columns[2:] if str(c).endswith("1231")][:5]
        records: list[NormalizedRecord] = []
        for col in annual_cols:
            year = str(col)[:4]
            revenue = value("营业总收入", col)
            net_profit = value("归母净利润", col)
            debt_ratio = value("资产负债率", col)
            equity = value("股东权益合计(净资产)", col)
            total_assets = None
            total_liabilities = None
            if equity is not None and debt_ratio is not None and 0 <= debt_ratio < 100:
                total_assets = equity / (1 - debt_ratio / 100)
                total_liabilities = total_assets - equity

            metrics: dict[str, float] = {}
            for key, indicator, unit in FINANCE_METRICS:
                v = value(indicator, col)
                if v is None:
                    continue
                if unit == "wan":
                    metrics[key] = round(v / 1e4, 2)
                elif unit == "ratio":
                    metrics[key] = round(v, 4)
                else:
                    metrics[key] = round(v, 6)

            records.append(NormalizedRecord(
                kind="finance",
                external_id=f"{code}-{year}-annual",
                source="akshare:stock_financial_abstract",
                raw_ref=f"akshare.stock_financial_abstract(symbol={code})",
                payload={
                    "year": year,
                    "report_type": "年报",
                    "revenue": round((revenue or 0) / 1e4, 2),
                    "net_profit": round((net_profit or 0) / 1e4, 2),
                    "debt_ratio": round(debt_ratio or 0, 2),
                    "total_assets": round((total_assets or 0) / 1e4, 2),
                    "total_liabilities": round((total_liabilities or 0) / 1e4, 2),
                    "source": "AkShare/东方财富（公开财报）",
                    "metrics_json": json.dumps(metrics, ensure_ascii=False),
                },
            ))
        return FetchResult("finance", self.name, records=records)


    # ---------- 舆情 ----------
    def fetch_news(self, enterprise, limit: int = 30) -> FetchResult:
        code = (enterprise.stock_code or "").strip()
        if not code:
            return FetchResult("news", self.name, gap="无股票代码（非上市企业，需人工数据源）")
        try:
            import akshare as ak

            df = ak.stock_news_em(symbol=code)
        except Exception as exc:  # noqa: BLE001
            return FetchResult("news", self.name, error=f"{type(exc).__name__}: {exc}")

        records: list[NormalizedRecord] = []
        for _, row in df.head(limit).iterrows():
            title = str(row.get("新闻标题") or "").strip()
            if not title:
                continue
            content = str(row.get("新闻内容") or "").strip()
            published = str(row.get("发布时间") or "")[:10]
            url = str(row.get("新闻链接") or "")
            records.append(NormalizedRecord(
                kind="news",
                external_id=f"{code}-{abs(hash(title)) % (10 ** 12)}",
                source="akshare:stock_news_em",
                raw_ref=url,
                payload={
                    "title": title[:300],
                    "content": content[:1000],
                    "source": str(row.get("文章来源") or "东方财富")[:120],
                    "url": url[:400],
                    "published_at": published,
                    "sentiment": classify_sentiment(title + content),
                },
            ))
        return FetchResult("news", self.name, records=records)

    # ---------- 诉讼统计 ----------
    def fetch_legal(self, enterprise, days: int = 540) -> FetchResult:
        code = (enterprise.stock_code or "").strip()
        if not code:
            return FetchResult("legal", self.name, gap="无股票代码（非上市企业，需人工数据源）")
        end = date.today()
        start = end - timedelta(days=days)
        try:
            import akshare as ak

            df = ak.stock_cg_lawsuit_cninfo(
                symbol=_board_of(code),
                start_date=start.strftime("%Y%m%d"),
                end_date=end.strftime("%Y%m%d"),
            )
        except Exception as exc:  # noqa: BLE001
            return FetchResult("legal", self.name, error=f"{type(exc).__name__}: {exc}")

        rows = df[df["证券代码"].astype(str).str.zfill(6) == code]
        if rows.empty:
            return FetchResult("legal", self.name, records=[])  # 无诉讼记录 = 正常
        row = rows.iloc[0]
        count = int(row.get("诉讼次数") or 0)
        amount = float(row.get("诉讼金额") or 0)
        period = str(row.get("公告统计区间") or "")
        return FetchResult("legal", self.name, records=[NormalizedRecord(
            kind="legal",
            external_id=f"{code}-lawsuit-{start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}",
            source="akshare:stock_cg_lawsuit_cninfo",
            raw_ref="巨潮资讯-公司治理-公司诉讼统计",
            payload={
                "case_no": "",
                "doc_type": "诉讼统计",
                "title": f"公告期内诉讼 {count} 次（{period}）",
                "court": "巨潮资讯统计",
                "cause": "诉讼统计（公开披露汇总）",
                "amount": amount,
                "status": f"统计口径：{period}",
                "judgment_date": end.isoformat(),
                "source": "AkShare/巨潮资讯（公开披露）",
            },
        )])

    def fetch(self, enterprise, dimension: str, since: str | None = None) -> FetchResult:
        if dimension == "finance":
            return self.fetch_finance(enterprise)
        if dimension == "news":
            return self.fetch_news(enterprise)
        if dimension == "legal":
            return self.fetch_legal(enterprise)
        return FetchResult(dimension, self.name, error=f"unsupported dimension: {dimension}")


akshare_source = AkShareSource()

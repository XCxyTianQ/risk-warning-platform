"""AkShare 数据源：上市公司财务 / 舆情新闻 / 诉讼统计（免费公开数据）。

映射与单位约定：
- 财务：元 → 万元；只取年度报告期（列名 YYYYMMDD 且以 1231 结尾）
- 舆情：新闻标题/来源/链接/时间；情感用关键词规则（源无情感字段）
- 诉讼：巨潮"公司诉讼"专题统计（按板块拉全市场后按代码过滤），得到诉讼次数/金额
"""

from datetime import date, timedelta

from app.datasources.base import FetchResult, NormalizedRecord

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
            rows = df[df["指标"] == indicator]
            if rows.empty:
                return None
            raw = rows.iloc[0].get(col)
            try:
                v = float(raw)
            except (TypeError, ValueError):
                return None
            return None if v != v else v  # NaN 过滤

        annual_cols = [c for c in df.columns[2:] if str(c).endswith("1231")][:3]
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

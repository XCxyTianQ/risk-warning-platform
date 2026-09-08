"""公告数据源（东方财富公告大全，AkShare 封装）：舆情/法律信号的重要补充。

公告常含问询函、立案调查、处罚、冻结、退市风险提示等强风险信号，作为舆情维度的第二信源。
"""

from app.datasources.akshare_src import classify_sentiment
from app.datasources.base import FetchResult, NormalizedRecord


class AnnouncementSource:
    name = "akshare:notice_em"
    dimensions = ["news"]

    def fetch_news(self, enterprise, limit: int = 30) -> FetchResult:
        code = (enterprise.stock_code or "").strip()
        if not code:
            return FetchResult("news", self.name, gap="无股票代码")
        try:
            import akshare as ak

            df = ak.stock_individual_notice_report(security=code, symbol="全部")
        except Exception as exc:  # noqa: BLE001
            return FetchResult("news", self.name, error=f"{type(exc).__name__}: {exc}")

        records: list[NormalizedRecord] = []
        for _, row in df.head(limit).iterrows():
            title = str(row.get("公告标题") or "").strip()
            if not title:
                continue
            url = str(row.get("网址") or "")
            published = str(row.get("公告日期") or "")[:10]
            records.append(NormalizedRecord(
                kind="news",
                external_id=f"notice-{abs(hash(url or title)) % (10 ** 12)}",
                source="akshare:notice_em",
                raw_ref=url,
                payload={
                    "title": f"[公告] {title}"[:300],
                    "content": f"公告类型：{row.get('公告类型') or '其他'}",
                    "source": "东方财富公告",
                    "url": url[:400],
                    "published_at": published,
                    "sentiment": classify_sentiment(title),
                },
            ))
        return FetchResult("news", self.name, records=records)

    def fetch(self, enterprise, dimension: str, since: str | None = None) -> FetchResult:
        if dimension == "news":
            return self.fetch_news(enterprise)
        return FetchResult(dimension, self.name, error=f"unsupported dimension: {dimension}")


announcement_source = AnnouncementSource()

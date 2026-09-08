"""数据源注册表：按维度选择数据源 + 降级链 + 拉取入库。"""

from sqlalchemy.orm import Session as DbSession

from app.datasources.akshare_src import akshare_source
from app.datasources.base import DataSource, FetchResult, NormalizedRecord
from app.db.models import Enterprise, Finance, LegalRecord, News

# 维度 → 数据源优先级（后续可插入 paid_src / manual_src）
PRIORITY: dict[str, list[DataSource]] = {
    "finance": [akshare_source],
    "news": [akshare_source],
    "legal": [akshare_source],
}


def fetch_dimension(db: DbSession, enterprise: Enterprise, dimension: str) -> FetchResult:
    """按优先级依次尝试，全部失败则返回带 error/gap 的结果（不抛异常）。"""
    last = FetchResult(dimension, "none", error="无可用数据源")
    for source in PRIORITY.get(dimension, []):
        result = source.fetch(enterprise, dimension)
        if result.ok and result.records:
            return result
        last = result
    return last


def upsert_records(db: DbSession, enterprise_id: int, result: FetchResult) -> dict:
    """幂等入库：财务按 (企业, 年份, 报告类型) 覆盖；新闻/法律按来源 external_id 去重。"""
    inserted = updated = 0
    for rec in result.records:
        if rec.kind == "finance":
            row = (
                db.query(Finance)
                .filter(
                    Finance.enterprise_id == enterprise_id,
                    Finance.year == rec.payload["year"],
                    Finance.report_type == rec.payload["report_type"],
                )
                .first()
            )
            if row is None:
                db.add(Finance(enterprise_id=enterprise_id, **rec.payload))
                inserted += 1
            else:
                for k, v in rec.payload.items():
                    setattr(row, k, v)
                updated += 1
        elif rec.kind == "news":
            exists = (
                db.query(News)
                .filter(News.enterprise_id == enterprise_id, News.title == rec.payload["title"])
                .first()
            )
            if exists is None:
                db.add(News(enterprise_id=enterprise_id, **rec.payload))
                inserted += 1
        elif rec.kind == "legal":
            exists = (
                db.query(LegalRecord)
                .filter(
                    LegalRecord.enterprise_id == enterprise_id,
                    LegalRecord.title == rec.payload["title"],
                )
                .first()
            )
            if exists is None:
                db.add(LegalRecord(enterprise_id=enterprise_id, **rec.payload))
                inserted += 1
    db.commit()
    return {"inserted": inserted, "updated": updated}


def refresh_enterprise(db: DbSession, enterprise_id: int, dimensions: list[str] | None = None) -> dict:
    """从数据源刷新一家企业（返回每个维度的拉取/入库统计）。"""
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        return {"error": f"企业不存在: {enterprise_id}"}

    dims = dimensions or ["finance", "news", "legal"]
    out: dict = {
        "enterprise": {"id": ent.id, "name": ent.name, "stock_code": ent.stock_code},
        "dimensions": {},
    }
    for dim in dims:
        result = fetch_dimension(db, ent, dim)
        if not result.ok:
            out["dimensions"][dim] = {
                "ok": False,
                "source": result.source,
                "error": result.error,
                "gap": result.gap,
            }
            continue
        stats = upsert_records(db, enterprise_id, result)
        out["dimensions"][dim] = {
            "ok": True,
            "source": result.source,
            "fetched": len(result.records),
            **stats,
        }
    return out

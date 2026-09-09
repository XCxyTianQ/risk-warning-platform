"""数据源注册表：按维度选择数据源 + 降级链 + 多信源合并 + 幂等入库。"""

import json

from sqlalchemy.orm import Session as DbSession

from app.datasources.akshare_src import akshare_source
from app.datasources.announcement_src import announcement_source
from app.datasources.base import DataSource, FetchResult, NormalizedRecord
from app.datasources.sina_src import sina_source
from app.db.models import Enterprise, Finance, LegalRecord, News

# 维度 → 数据源优先级（靠前者优先；news/finance 维度多信源合并）
# finance 合并的意义：东财摘要提供比率类指标，新浪三表提供绝对值科目（Z/F/M 模型输入），
# 二者按 (年份, 报告类型) 做字段级合并，任一信源缺失都不影响另一信源的贡献。
SOURCES: dict[str, list[DataSource]] = {
    "finance": [akshare_source, sina_source],       # 东财摘要 + 新浪三表（字段级合并）
    "news": [akshare_source, announcement_source],  # 东财个股新闻 + 东财公告（合并）
    "legal": [akshare_source],                      # 巨潮诉讼统计
}
MERGE_DIMS = {"news", "finance"}


def source_status() -> list[dict]:
    """供前端"数据源"页展示。"""
    return [
        {
            "dimension": dim,
            "sources": [{"name": s.name, "dimensions": s.dimensions} for s in sources],
            "mode": "merge" if dim in MERGE_DIMS else "fallback",
        }
        for dim, sources in SOURCES.items()
    ]


def fetch_dimension(db: DbSession, enterprise: Enterprise, dimension: str) -> FetchResult:
    """按优先级拉取：news 合并多源；其余首个成功源生效。全部失败返回带 error/gap 的结果。"""
    sources = SOURCES.get(dimension, [])
    if not sources:
        return FetchResult(dimension, "none", error=f"无数据源: {dimension}")

    merged: list[NormalizedRecord] = []
    used: list[str] = []
    errors: list[str] = []
    gap = ""

    for source in sources:
        result = source.fetch(enterprise, dimension)
        if result.ok and result.records:
            merged.extend(result.records)
            used.append(result.source)
            if dimension not in MERGE_DIMS:
                break  # 非合并维度：首个成功即用
        elif result.ok:
            used.append(result.source)  # 成功但无记录（如无诉讼）
            if dimension not in MERGE_DIMS:
                break
        else:
            errors.append(f"{result.source}: {result.gap or result.error}")
            gap = gap or result.gap

    if merged:
        return FetchResult(dimension, "+".join(used), records=merged)
    if used:
        return FetchResult(dimension, "+".join(used), records=[])
    return FetchResult(dimension, "none", error="; ".join(errors), gap=gap)


def _load_json(raw: str) -> dict:
    """安全解析 JSON 对象（脏数据/空值返回空字典）。"""
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def upsert_records(db: DbSession, enterprise_id: int, result: FetchResult) -> dict:
    """幂等入库：财务按 (企业, 年份, 报告类型) 覆盖并做指标字段级合并；新闻/法律按标题去重。"""
    inserted = updated = 0
    for rec in result.records:
        if rec.kind == "finance":
            payload = dict(rec.payload)
            incoming = _load_json(payload.pop("metrics_json", ""))
            row = (
                db.query(Finance)
                .filter(
                    Finance.enterprise_id == enterprise_id,
                    Finance.year == payload["year"],
                    Finance.report_type == payload["report_type"],
                )
                .first()
            )
            if row is None:
                db.add(Finance(
                    enterprise_id=enterprise_id,
                    metrics_json=json.dumps(incoming, ensure_ascii=False),
                    **payload,
                ))
                db.flush()  # 立即可见：多信源在同一次刷新内按 (年份, 报告类型) 合并到同一行
                inserted += 1
            else:
                merged = _load_json(row.metrics_json)
                merged.update(incoming)
                row.metrics_json = json.dumps(merged, ensure_ascii=False)
                for k, v in payload.items():
                    if k == "source":
                        # 多信源合并：保留两段来源说明
                        if v and v not in (row.source or ""):
                            row.source = (f"{row.source}+{v}" if row.source else v)[:200]
                        continue
                    # 顶层字段：非零值才覆盖，避免缺失信源把已有数据清零
                    if v or not getattr(row, k, 0):
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
    """从数据源刷新一家企业（返回每个维度的拉取/入库统计），并记录各维度数据状态。"""
    import json as _json

    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        return {"error": f"企业不存在: {enterprise_id}"}

    try:
        status = _json.loads(ent.data_status_json or "{}")
    except ValueError:
        status = {}

    dims = dimensions or ["finance", "news", "legal"]
    out: dict = {
        "enterprise": {"id": ent.id, "name": ent.name, "stock_code": ent.stock_code},
        "dimensions": {},
    }
    for dim in dims:
        result = fetch_dimension(db, ent, dim)
        if not result.ok:
            status[dim] = "error" if result.error else "never"
            out["dimensions"][dim] = {
                "ok": False,
                "source": result.source,
                "error": result.error,
                "gap": result.gap,
            }
            continue
        stats = upsert_records(db, enterprise_id, result)
        # ok=查到记录；empty=查过但确实没有（可判 0 风险）
        status[dim] = "ok" if result.records else "empty"
        out["dimensions"][dim] = {
            "ok": True,
            "source": result.source,
            "fetched": len(result.records),
            **stats,
        }

    ent.data_status_json = _json.dumps(status, ensure_ascii=False)
    db.commit()
    out["data_status"] = status

    # 数据刷新后重算评分并生成/更新预警工单（闭环）
    try:
        from app.services.alerts import generate_for_enterprise

        alert_result = generate_for_enterprise(db, enterprise_id, source="scoring")
        out["alerts_created"] = len(alert_result.get("created", []))
    except Exception:  # noqa: BLE001 —— 预警失败不影响刷新结果
        out["alerts_created"] = 0
    return out

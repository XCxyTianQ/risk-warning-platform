"""API 路由：企业档案 / 风险研判（阶段2）。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import Enterprise
from app.services.risk import analyze_enterprise, risk_snapshot

router = APIRouter(prefix="/api", tags=["enterprise"])


class AnalyzeByName(BaseModel):
    name: str


class CreateEnterpriseIn(BaseModel):
    name: str
    stock_code: str | None = None
    auto_fetch: bool = True
    industry: str = ""


def _get_ent(db: Session, enterprise_id: int) -> Enterprise:
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        raise HTTPException(404, f"enterprise {enterprise_id} not found")
    return ent


@router.get("/enterprises")
def list_enterprises(q: str = "", db: Session = Depends(get_db)):
    """企业列表；`q` 可按名称、行业或股票代码过滤。"""
    from app.datasources.codes import normalize_code

    query = db.query(Enterprise)
    kw = (q or "").strip()
    if kw:
        code = normalize_code(kw)
        cond = (
            (Enterprise.name.contains(kw))
            | (Enterprise.industry.contains(kw))
            | (Enterprise.stock_code.contains(kw))
            | (Enterprise.unified_code.contains(kw))
        )
        if code:
            cond = cond | (Enterprise.stock_code == code)
        query = query.filter(cond)
    rows = query.order_by(Enterprise.id).all()
    return {"total": len(rows), "items": [
        {"id": e.id, "name": e.name, "industry": e.industry, "reg_date": e.reg_date,
         "stock_code": e.stock_code}
        for e in rows
    ]}


@router.get("/enterprise/{enterprise_id}")
def get_enterprise(enterprise_id: int, db: Session = Depends(get_db)):
    ent = _get_ent(db, enterprise_id)
    return {
        "id": ent.id, "name": ent.name, "unified_code": ent.unified_code,
        "stock_code": ent.stock_code,
        "legal_rep": ent.legal_rep, "reg_capital_wan": ent.reg_capital_wan,
        "reg_date": ent.reg_date, "industry": ent.industry, "address": ent.address,
        "data_note": ent.data_note,
    }


@router.get("/resolve_stock")
def resolve_stock(name: str):
    """企业名称 → 股票代码候选（添加企业时确认用）。"""
    from app.services.enterprise import lookup_stock

    return lookup_stock(name)


@router.post("/enterprises")
def create_enterprise(body: CreateEnterpriseIn, db: Session = Depends(get_db)):
    """自由添加企业：可自动解析股票代码并拉取公开数据。"""
    from app.services.enterprise import create_enterprise as create

    result = create(db, body.name, body.stock_code, body.auto_fetch, body.industry)
    if result.get("error"):
        raise HTTPException(409 if "已存在" in result["error"] else 400, result["error"])
    return result


@router.delete("/enterprise/{enterprise_id}")
def delete_enterprise(enterprise_id: int, db: Session = Depends(get_db)):
    from app.services.enterprise import delete_enterprise as delete

    result = delete(db, enterprise_id)
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.get("/datasources")
def datasources():
    """当前启用的数据源与维度覆盖（多信源状态）。"""
    from app.datasources.registry import source_status

    return {"sources": source_status()}


@router.post("/enterprises/analyze_by_name")
def analyze_by_name(body: AnalyzeByName, db: Session = Depends(get_db)):
    """按名称或股票代码发起研判。"""
    from app.datasources.codes import normalize_code

    raw = body.name.strip()
    ent = None
    code = normalize_code(raw)
    if code:
        ent = db.query(Enterprise).filter(Enterprise.stock_code == code).first()
        if ent is None:
            raise HTTPException(
                404,
                f"平台内未找到股票代码 {raw} 对应的企业；请先在「企业档案」中添加建档。",
            )
    if ent is None:
        ent = (
            db.query(Enterprise)
            .filter(func.instr(Enterprise.name, raw) > 0)
            .first()
        )
    if ent is None:
        # 尝试精确匹配后再给 404
        ent = db.query(Enterprise).filter(Enterprise.name == raw).first()
    if ent is None:
        raise HTTPException(404, f"企业不存在：{body.name}（请先 seed 样例数据）")
    try:
        return analyze_enterprise(db, ent.id)
    except Exception as exc:  # noqa: BLE001 —— LLM 异常对外可读
        raise HTTPException(500, f"研判失败：{exc}") from exc


@router.get("/enterprise/{enterprise_id}/risk")
def enterprise_risk(enterprise_id: int, db: Session = Depends(get_db)):
    return risk_snapshot(db, enterprise_id)


@router.post("/enterprise/{enterprise_id}/refresh")
def refresh_enterprise_data(
    enterprise_id: int,
    dimensions: str | None = None,
    db: Session = Depends(get_db),
):
    """从公开数据源（AkShare）刷新企业数据：finance / news / legal。"""
    from app.datasources import refresh_enterprise

    dims = [d.strip() for d in dimensions.split(",") if d.strip()] if dimensions else None
    try:
        return refresh_enterprise(db, enterprise_id, dims)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"数据源刷新失败：{exc}") from exc

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


def _get_ent(db: Session, enterprise_id: int) -> Enterprise:
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        raise HTTPException(404, f"enterprise {enterprise_id} not found")
    return ent


@router.get("/enterprises")
def list_enterprises(db: Session = Depends(get_db)):
    rows = db.query(Enterprise).order_by(Enterprise.id).all()
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


@router.post("/enterprises/analyze_by_name")
def analyze_by_name(body: AnalyzeByName, db: Session = Depends(get_db)):
    ent = (
        db.query(Enterprise)
        .filter(func.instr(Enterprise.name, body.name.strip()) > 0)
        .first()
    )
    if ent is None:
        # 尝试精确匹配后再给 404
        ent = db.query(Enterprise).filter(Enterprise.name == body.name.strip()).first()
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

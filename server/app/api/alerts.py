"""预警中心 API：生成 / 列表 / 处置 / 报告。"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db.database import get_db
from app.services import alerts as svc

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


class HandleIn(BaseModel):
    action: str
    handler: str = ""
    note: str = ""


class GenerateIn(BaseModel):
    enterprise_id: int | None = None


@router.get("")
def list_alerts(
    status: str | None = Query(None),
    level: str | None = Query(None),
    enterprise_id: int | None = Query(None),
    limit: int = Query(200, le=500),
    db: DbSession = Depends(get_db),
):
    return svc.list_alerts(db, status, level, enterprise_id, limit)


@router.get("/summary")
def alert_summary(db: DbSession = Depends(get_db)):
    return svc.summary(db)


@router.post("/generate")
def generate(body: GenerateIn, db: DbSession = Depends(get_db)):
    if body.enterprise_id:
        return svc.generate_for_enterprise(db, body.enterprise_id)
    return svc.generate_all(db)


@router.post("/{alert_id}/handle")
def handle(alert_id: int, body: HandleIn, db: DbSession = Depends(get_db)):
    result = svc.handle_alert(db, alert_id, body.action, body.handler, body.note)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.get("/{alert_id}/report", response_class=PlainTextResponse)
def report(alert_id: int, db: DbSession = Depends(get_db)):
    text = svc.report_markdown(db, alert_id)
    if not text:
        raise HTTPException(404, f"预警不存在: {alert_id}")
    return PlainTextResponse(
        text,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="alert-{alert_id}.md"'},
    )

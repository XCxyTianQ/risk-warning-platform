"""设置 API（DSH 风格设置面板数据源）。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db.database import get_db
from app.services import settings_store as svc

router = APIRouter(prefix="/api/settings", tags=["settings"])


class UpdateIn(BaseModel):
    values: dict


class ModelsIn(BaseModel):
    base_url: str
    api_key: str | None = None


@router.get("")
def get_settings(db: DbSession = Depends(get_db)):
    return svc.get_view(db)


@router.get("/providers")
def providers():
    return {"providers": svc.PROVIDERS}


@router.post("/models")
def list_models(body: ModelsIn):
    """按提供商端点拉取可用模型列表（快速部署向导第三步）。"""
    return svc.list_models(body.base_url, body.api_key)


@router.put("")
def update_settings(body: UpdateIn, db: DbSession = Depends(get_db)):
    result = svc.update(db, body.values or {})
    if result.get("errors"):
        raise HTTPException(400, "; ".join(result["errors"]))
    return {"ok": True, **result, "settings": svc.get_view(db)}


@router.post("/preheat")
def trigger_preheat():
    """手动预热提示词缓存。"""
    from app.agent.prompt import SYSTEM_PROMPT
    from app.agent.tools import build_registry
    from app.llm.preheat import warmer

    return warmer.warm(SYSTEM_PROMPT, build_registry().definitions(), force=True, label="manual")


@router.get("/preheat")
def preheat_status():
    from app.llm.preheat import warmer

    return warmer.status()


@router.post("/reset")
def reset_settings(db: DbSession = Depends(get_db)):
    return svc.reset(db)

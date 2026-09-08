"""插件与预设 API（DSH 组合理念：预设 = 提示词 + 工具白名单 + 技能白名单 + 模型覆盖）。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db.database import get_db
from app.services import plugins as svc

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class ToolIn(BaseModel):
    name: str
    description: str = ""
    parameters: dict | None = None
    method: str = "GET"
    url: str
    headers: dict | None = None
    body_template: str = ""
    enabled: bool = True
    require_approval: bool = False


class ToolPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    parameters: dict | None = None
    method: str | None = None
    url: str | None = None
    headers: dict | None = None
    body_template: str | None = None
    enabled: bool | None = None
    require_approval: bool | None = None


class PresetIn(BaseModel):
    name: str
    description: str = ""
    prompt_extra: str = ""
    tools: list[str] | None = None
    skills: list[str] | None = None
    model_override: str = ""
    enabled: bool = True


class PresetPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    prompt_extra: str | None = None
    tools: list[str] | None = None
    skills: list[str] | None = None
    model_override: str | None = None
    enabled: bool | None = None


# ---------- 自定义工具（插件） ----------
@router.get("/tools")
def list_tools(db: DbSession = Depends(get_db)):
    return svc.list_custom_tools(db)


@router.post("/tools")
def create_tool(body: ToolIn, db: DbSession = Depends(get_db)):
    result = svc.create_custom_tool(db, **body.model_dump())
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.patch("/tools/{tool_id}")
def update_tool(tool_id: int, body: ToolPatch, db: DbSession = Depends(get_db)):
    result = svc.update_custom_tool(db, tool_id, **body.model_dump(exclude_none=True))
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.delete("/tools/{tool_id}")
def delete_tool(tool_id: int, db: DbSession = Depends(get_db)):
    result = svc.delete_custom_tool(db, tool_id)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.post("/tools/{tool_id}/test")
def test_tool(tool_id: int, args: dict | None = None, db: DbSession = Depends(get_db)):
    from app.db.models import CustomTool

    row = db.get(CustomTool, tool_id)
    if row is None:
        raise HTTPException(404, f"工具不存在: {tool_id}")
    return svc.run_custom_tool(row, args or {})


# ---------- Agent 预设 ----------
@router.get("/presets")
def list_presets(db: DbSession = Depends(get_db)):
    return svc.list_presets(db)


@router.post("/presets")
def create_preset(body: PresetIn, db: DbSession = Depends(get_db)):
    result = svc.create_preset(db, **body.model_dump())
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.patch("/presets/{preset_id}")
def update_preset(preset_id: int, body: PresetPatch, db: DbSession = Depends(get_db)):
    result = svc.update_preset(db, preset_id, **body.model_dump(exclude_none=True))
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.delete("/presets/{preset_id}")
def delete_preset(preset_id: int, db: DbSession = Depends(get_db)):
    result = svc.delete_preset(db, preset_id)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.post("/presets/seed")
def seed_presets(db: DbSession = Depends(get_db)):
    return {"created": svc.seed_builtin_presets(db)}

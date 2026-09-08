"""技能 API。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db.database import get_db
from app.skills import service as svc

router = APIRouter(prefix="/api/skills", tags=["skills"])


class SkillIn(BaseModel):
    name: str
    description: str = ""
    content: str


class SkillPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = None
    enabled: bool | None = None


@router.get("")
def list_skills(enabled_only: bool = False, db: DbSession = Depends(get_db)):
    return svc.list_skills(db, enabled_only)


@router.post("")
def create_skill(body: SkillIn, db: DbSession = Depends(get_db)):
    result = svc.create_skill(db, body.name, body.description, body.content)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.patch("/{skill_id}")
def update_skill(skill_id: int, body: SkillPatch, db: DbSession = Depends(get_db)):
    result = svc.update_skill(db, skill_id, **body.model_dump(exclude_none=True))
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.delete("/{skill_id}")
def delete_skill(skill_id: int, db: DbSession = Depends(get_db)):
    result = svc.delete_skill(db, skill_id)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.post("/seed")
def seed(db: DbSession = Depends(get_db)):
    return {"created": svc.seed_builtin(db)}

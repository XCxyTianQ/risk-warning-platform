"""分享链接（只读会话快照，无需登录）。"""

from fastapi import APIRouter, HTTPException
from sqlalchemy.orm import Session as DbSession

from app.agent.session import store
from app.db.database import get_db
from fastapi import Depends

router = APIRouter(prefix="/api/share", tags=["share"])


@router.get("/{token}")
def get_shared(token: str, db: DbSession = Depends(get_db)):
    data = store.get_shared(db, token)
    if data is None:
        raise HTTPException(404, "分享链接无效或已撤销")
    return data

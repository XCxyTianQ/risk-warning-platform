"""对话式研判 API（SSE 流式 + 会话历史持久化）。"""

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.agent.loop import run_agent
from app.agent.session import store
from app.db.database import SessionLocal, get_db

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatIn(BaseModel):
    message: str
    session_id: str | None = None


class ApprovalIn(BaseModel):
    approval_id: str
    approved: bool


@router.post("/approve")
def approve(body: ApprovalIn):
    """动作工具审批：前端确认后恢复被暂停的 Agent 循环。"""
    from app.agent import approvals

    ok = approvals.resolve(body.approval_id, body.approved)
    if not ok:
        raise HTTPException(404, "审批请求不存在或已处理（可能已超时）")
    return {"approval_id": body.approval_id, "approved": body.approved}


@router.get("/sessions")
def list_sessions(limit: int = 20, db: DbSession = Depends(get_db)):
    return {"sessions": store.list(db, limit=limit)}


@router.post("/sessions")
def create_session(db: DbSession = Depends(get_db)):
    s = store.create(db)
    return {"session_id": s.id, "title": s.title, "created_at": s.created_at.isoformat()}


@router.get("/sessions/{session_id}")
def get_session(session_id: str, db: DbSession = Depends(get_db)):
    s = store.get(db, session_id)
    if s is None:
        raise HTTPException(404, "会话不存在")
    return {
        "session_id": s.id,
        "title": s.title,
        "updated_at": s.updated_at.isoformat(),
        "messages": [
            {
                "role": m.get("role"),
                "content": m.get("content") or "",
                "tool_calls": m.get("tool_calls") or [],
                "tool_call_id": m.get("tool_call_id", ""),
                "tool_name": m.get("tool_name", ""),
            }
            for m in s.messages
        ],
    }


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, db: DbSession = Depends(get_db)):
    if not store.delete(db, session_id):
        raise HTTPException(404, "会话不存在")
    return {"deleted": session_id}


@router.post("/stream")
def chat_stream(body: ChatIn):
    """SSE：session / token / tool / tool_result / done / error 事件。"""
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(400, "消息不能为空")

    def generator():
        db = SessionLocal()
        try:
            session = store.get_or_create(db, body.session_id)
            yield f"event: session\ndata: {json.dumps({'session_id': session.id, 'title': session.title}, ensure_ascii=False)}\n\n"
            for ev in run_agent(db, session, message):
                yield ev.to_sse()
        finally:
            db.close()

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

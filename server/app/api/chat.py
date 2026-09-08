"""对话式研判 API（SSE 流式）。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent.loop import run_agent
from app.agent.session import store
from app.db.database import SessionLocal

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatIn(BaseModel):
    message: str
    session_id: str | None = None


@router.post("/sessions")
def create_session():
    s = store.create()
    return {"session_id": s.id, "created_at": s.created_at.isoformat()}


@router.get("/sessions/{session_id}")
def get_session(session_id: str):
    s = store.get(session_id)
    if s is None:
        raise HTTPException(404, "会话不存在或已过期（原型期会话存于内存）")
    return {
        "session_id": s.id,
        "title": s.title,
        "messages": [
            {"role": m.get("role"), "content": m.get("content")}
            for m in s.messages
            if m.get("role") in ("user", "assistant") and m.get("content")
        ],
    }


@router.post("/stream")
def chat_stream(body: ChatIn):
    """SSE：token / tool / tool_result / done / error 事件。"""
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(400, "消息不能为空")
    session = store.get_or_create(body.session_id)

    def generator():
        db = SessionLocal()
        try:
            yield f"event: session\ndata: {{\"session_id\": \"{session.id}\"}}\n\n"
            for ev in run_agent(db, session, message):
                yield ev.to_sse()
        finally:
            db.close()

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

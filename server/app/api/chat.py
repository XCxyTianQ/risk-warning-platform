"""对话式研判 API（SSE 流式 + 会话历史持久化）。"""

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.agent.loop import run_agent
from app.agent.session import store
from app.db.database import SessionLocal, get_db

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatIn(BaseModel):
    message: str
    session_id: str | None = None
    preset_id: int | None = None


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
def list_sessions(limit: int = 50, q: str = "", db: DbSession = Depends(get_db)):
    return {"sessions": store.list_sessions(db, limit=limit, q=q)}


class SessionPatch(BaseModel):
    title: str | None = None
    pinned: bool | None = None


class BatchDeleteIn(BaseModel):
    ids: list[str]


class SessionImportIn(BaseModel):
    data: dict


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, body: SessionPatch, db: DbSession = Depends(get_db)):
    if body.title is not None:
        result = store.rename(db, session_id, body.title)
        if result.get("error"):
            raise HTTPException(404, result["error"])
    if body.pinned is not None:
        result = store.set_pinned(db, session_id, body.pinned)
        if result.get("error"):
            raise HTTPException(404, result["error"])
    return {"ok": True, "session_id": session_id}


@router.post("/sessions/{session_id}/clear")
def clear_session(session_id: str, db: DbSession = Depends(get_db)):
    result = store.clear_messages(db, session_id)
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.post("/sessions/batch_delete")
def batch_delete(body: BatchDeleteIn, db: DbSession = Depends(get_db)):
    return store.batch_delete(db, body.ids)


@router.get("/sessions/{session_id}/export")
def export_session(session_id: str, format: str = "md", db: DbSession = Depends(get_db)):
    """导出会话：format=md（可读报告）/ json（可再导入）。"""
    if format == "json":
        data = store.export_json(db, session_id)
        if not data:
            raise HTTPException(404, "会话不存在")
        return data
    text = store.export_markdown(db, session_id)
    if not text:
        raise HTTPException(404, "会话不存在")
    return PlainTextResponse(
        text,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="session-{session_id}.md"'},
    )


@router.post("/sessions/{session_id}/share")
def share_session(session_id: str, db: DbSession = Depends(get_db)):
    result = store.share(db, session_id)
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.delete("/sessions/{session_id}/share")
def revoke_share(session_id: str, db: DbSession = Depends(get_db)):
    result = store.revoke_share(db, session_id)
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.post("/import")
def import_session(body: SessionImportIn, db: DbSession = Depends(get_db)):
    result = store.import_session(db, body.data)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


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
        "summary": s.summary,
        "usage": store.usage_stats(s),
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


@router.get("/usage")
def usage_summary(session_id: str | None = None, db: DbSession = Depends(get_db)):
    """全局/会话用量与成本（常驻状态栏数据源）。"""
    from sqlalchemy import func

    from app.core.config import settings
    from app.db.models import ChatSession

    row = db.query(
        func.count(ChatSession.id),
        func.coalesce(func.sum(ChatSession.llm_calls), 0),
        func.coalesce(func.sum(ChatSession.prompt_tokens), 0),
        func.coalesce(func.sum(ChatSession.completion_tokens), 0),
        func.coalesce(func.sum(ChatSession.cache_hit_tokens), 0),
        func.coalesce(func.sum(ChatSession.cache_miss_tokens), 0),
        func.coalesce(func.sum(ChatSession.est_cost), 0.0),
        func.coalesce(func.sum(ChatSession.compact_count), 0),
    ).first()
    sessions, calls, prompt, completion, hit, miss, cost, compacts = row
    cache_total = (hit or 0) + (miss or 0)
    global_stats = {
        "sessions": sessions or 0,
        "llm_calls": calls or 0,
        "prompt_tokens": prompt or 0,
        "completion_tokens": completion or 0,
        "cache_hit_tokens": hit or 0,
        "cache_miss_tokens": miss or 0,
        "cache_hit_rate": round((hit or 0) / cache_total, 4) if cache_total else 0.0,
        "compact_count": compacts or 0,
    }
    session_stats = None
    if session_id:
        s = store.get(db, session_id)
        if s is not None:
            session_stats = {"session_id": s.id, "title": s.title, **store.usage_stats(s)}
    return {
        "model": settings.llm_model,
        "context_window": settings.llm_context_window,
        "threshold_ratio": settings.compaction_threshold_ratio,
        "retain_ratio": settings.compaction_retain_ratio,
        "global": global_stats,
        "session": session_stats,
        "preheat": _preheat_status(),
    }


def _preheat_status() -> dict:
    from app.llm.preheat import warmer

    return warmer.status()


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
            # 新会话首个请求：预热静态前缀（system+tools），让本次即命中缓存
            if not session.messages:
                from app.agent.prompt import SYSTEM_PROMPT
                from app.agent.tools import build_registry
                from app.llm.preheat import warmer

                warmer.warm(SYSTEM_PROMPT, build_registry().definitions(), label="new-session")
            yield f"event: session\ndata: {json.dumps({'session_id': session.id, 'title': session.title}, ensure_ascii=False)}\n\n"
            for ev in run_agent(db, session, message, preset_id=body.preset_id):
                yield ev.to_sse()
        finally:
            db.close()

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

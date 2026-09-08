"""会话管理（DB 持久化版）：会话与消息落库，支持历史回放与多轮追问。"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from app.db.models import ChatMessage, ChatSession

WINDOW = 12          # 送入模型的最近消息条数（上下文恒定）
MAX_TITLE_LEN = 24


@dataclass
class Session:
    id: str
    title: str = "新对话"
    messages: list[dict] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)


class SessionStore:
    """DB 持久化会话存储；内存中只保留当前会话对象。"""

    def create(self, db: DbSession, title: str = "新对话") -> Session:
        sid = uuid.uuid4().hex[:12]
        row = ChatSession(id=sid, title=title)
        db.add(row)
        db.commit()
        return Session(id=sid, title=title)

    def get(self, db: DbSession, session_id: str) -> Session | None:
        row = db.get(ChatSession, session_id)
        if row is None:
            return None
        msgs = (
            db.query(ChatMessage)
            .filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id)
            .all()
        )
        session = Session(
            id=row.id,
            title=row.title,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for m in msgs:
            item: dict = {"role": m.role, "content": m.content}
            if m.tool_calls_json:
                try:
                    item["tool_calls"] = json.loads(m.tool_calls_json)
                except ValueError:
                    item["tool_calls"] = []
            if m.tool_call_id:
                item["tool_call_id"] = m.tool_call_id
            if m.tool_name:
                item["tool_name"] = m.tool_name
            session.messages.append(item)
        return session

    def get_or_create(self, db: DbSession, session_id: str | None) -> Session:
        if session_id:
            existing = self.get(db, session_id)
            if existing is not None:
                return existing
        return self.create(db)

    def append(self, db: DbSession, session: Session, message: dict) -> None:
        session.messages.append(message)
        session.updated_at = datetime.utcnow()
        row = ChatMessage(
            session_id=session.id,
            role=message.get("role", ""),
            content=message.get("content") or "",
            tool_calls_json=json.dumps(message["tool_calls"], ensure_ascii=False)
            if message.get("tool_calls") else "",
            tool_call_id=message.get("tool_call_id", ""),
            tool_name=message.get("tool_name", ""),
            ts=session.updated_at,
        )
        db.add(row)
        parent = db.get(ChatSession, session.id)
        if parent is not None:
            parent.updated_at = session.updated_at
            # 首条用户消息自动生成标题
            if parent.title in ("", "新对话") and message.get("role") == "user":
                text = (message.get("content") or "").strip().replace("\n", " ")
                if text:
                    parent.title = text[:MAX_TITLE_LEN] + ("…" if len(text) > MAX_TITLE_LEN else "")
                    session.title = parent.title
        db.commit()

    def context(self, session: Session) -> list[dict]:
        """最近 N 条消息（用于模型上下文；只取 role/content/tool 相关字段）。"""
        out = []
        for m in session.messages[-WINDOW:]:
            item = {"role": m.get("role"), "content": m.get("content") or ""}
            if m.get("tool_calls"):
                item["tool_calls"] = m["tool_calls"]
            if m.get("tool_call_id"):
                item["tool_call_id"] = m["tool_call_id"]
            out.append(item)
        return out

    def list(self, db: DbSession, limit: int = 20) -> list[dict]:
        counts = dict(
            db.query(ChatMessage.session_id, func.count(ChatMessage.id))
            .group_by(ChatMessage.session_id)
            .all()
        )
        rows = (
            db.query(ChatSession)
            .order_by(ChatSession.updated_at.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": r.id,
                "title": r.title,
                "updated_at": r.updated_at.isoformat(),
                "message_count": counts.get(r.id, 0),
            }
            for r in rows
        ]

    def delete(self, db: DbSession, session_id: str) -> bool:
        row = db.get(ChatSession, session_id)
        if row is None:
            return False
        db.query(ChatMessage).filter(ChatMessage.session_id == session_id).delete()
        db.delete(row)
        db.commit()
        return True


store = SessionStore()

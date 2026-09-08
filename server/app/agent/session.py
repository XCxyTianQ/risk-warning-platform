"""会话管理（DB 持久化 + 上下文压缩 + 用量/成本统计）。"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from app.core.config import settings
from app.db.models import ChatMessage, ChatSession

WINDOW = 12          # 送入模型的最近消息条数上限（配合摘要，上下文恒定）
MAX_TITLE_LEN = 24


@dataclass
class Session:
    id: str
    title: str = "新对话"
    messages: list[dict] = field(default_factory=list)
    summary: str = ""
    compacted_until: int = 0
    compact_count: int = 0
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    # 用量（会话累计）
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    llm_calls: int = 0
    est_cost: float = 0.0


def estimate_cost(cache_hit: int, cache_miss: int, output: int) -> float:  # noqa: ARG001
    """保留占位：平台不再展示金额估算。"""
    return 0.0


class SessionStore:
    def create(self, db: DbSession, title: str = "新对话") -> Session:
        sid = uuid.uuid4().hex[:12]
        db.add(ChatSession(id=sid, title=title))
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
            summary=row.summary or "",
            compacted_until=row.compacted_until or 0,
            compact_count=row.compact_count or 0,
            created_at=row.created_at,
            updated_at=row.updated_at,
            prompt_tokens=row.prompt_tokens or 0,
            completion_tokens=row.completion_tokens or 0,
            cache_hit_tokens=row.cache_hit_tokens or 0,
            cache_miss_tokens=row.cache_miss_tokens or 0,
            llm_calls=row.llm_calls or 0,
            est_cost=row.est_cost or 0.0,
        )
        for m in msgs:
            item: dict = {"id": m.id, "role": m.role, "content": m.content}
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

    def append(self, db: DbSession, session: Session, message: dict) -> dict:
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
        db.flush()
        message["id"] = row.id
        session.messages.append(message)

        parent = db.get(ChatSession, session.id)
        if parent is not None:
            parent.updated_at = session.updated_at
            if parent.title in ("", "新对话") and message.get("role") == "user":
                text = (message.get("content") or "").strip().replace("\n", " ")
                if text:
                    parent.title = text[:MAX_TITLE_LEN] + ("…" if len(text) > MAX_TITLE_LEN else "")
                    session.title = parent.title
        db.commit()
        return message

    def context(self, session: Session) -> list[dict]:
        """构建送入模型的上下文：system 摘要（若有）+ 压缩点之后的最近消息。

        - 只保留 role/content/tool_calls/tool_call_id（剥离内部 id 等字段）
        - 上下文体积恒定：更早的内容已被摘要替代
        """
        out: list[dict] = []
        if session.summary:
            out.append({
                "role": "system",
                "content": "[会话摘要（更早的对话已压缩，视为已知信息）]\n" + session.summary,
            })
        recent = [m for m in session.messages if (m.get("id") or 0) > session.compacted_until]
        for m in recent[-WINDOW:]:
            item = {"role": m.get("role"), "content": m.get("content") or ""}
            if m.get("tool_calls"):
                item["tool_calls"] = m["tool_calls"]
            if m.get("tool_call_id"):
                item["tool_call_id"] = m["tool_call_id"]
            out.append(item)
        return out

    def set_summary(self, db: DbSession, session: Session, summary: str, until_id: int) -> None:
        session.summary = summary
        session.compacted_until = until_id
        session.compact_count += 1
        row = db.get(ChatSession, session.id)
        if row is not None:
            row.summary = summary
            row.compacted_until = until_id
            row.compact_count = session.compact_count
        db.commit()

    def add_usage(self, db: DbSession, session: Session, usage: dict) -> dict:
        """累计一次 LLM 调用的用量与成本。"""
        hit = int(usage.get("cache_hit_tokens", 0) or 0)
        miss = int(usage.get("cache_miss_tokens", 0) or 0)
        prompt = int(usage.get("prompt_tokens", 0) or 0)
        output = int(usage.get("completion_tokens", 0) or 0)
        # 兼容未返回缓存明细的提供方：全部按未命中计
        if prompt and not (hit or miss):
            miss = prompt
        session.prompt_tokens += prompt
        session.completion_tokens += output
        session.cache_hit_tokens += hit
        session.cache_miss_tokens += miss
        session.llm_calls += 1

        row = db.get(ChatSession, session.id)
        if row is not None:
            row.prompt_tokens = session.prompt_tokens
            row.completion_tokens = session.completion_tokens
            row.cache_hit_tokens = session.cache_hit_tokens
            row.cache_miss_tokens = session.cache_miss_tokens
            row.llm_calls = session.llm_calls
        db.commit()
        return self.usage_stats(session)

    @staticmethod
    def usage_stats(session: Session) -> dict:
        """会话用量统计（不含金额估算）。"""
        total_cache = session.cache_hit_tokens + session.cache_miss_tokens
        hit_rate = round(session.cache_hit_tokens / total_cache, 4) if total_cache else 0.0
        return {
            "llm_calls": session.llm_calls,
            "prompt_tokens": session.prompt_tokens,
            "completion_tokens": session.completion_tokens,
            "cache_hit_tokens": session.cache_hit_tokens,
            "cache_miss_tokens": session.cache_miss_tokens,
            "cache_hit_rate": hit_rate,
            "compact_count": session.compact_count,
        }

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
                "cache_hit_rate": (
                    round((r.cache_hit_tokens or 0) / ((r.cache_hit_tokens or 0) + (r.cache_miss_tokens or 0)), 4)
                    if (r.cache_hit_tokens or 0) + (r.cache_miss_tokens or 0) else 0.0
                ),
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

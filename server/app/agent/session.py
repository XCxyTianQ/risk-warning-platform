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


def _missing_tool_result(tool_call_id: str) -> dict:
    """补齐缺失的工具结果：会话中断/窗口裁剪时使用，保证消息序列合法。"""
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": json.dumps(
            {"error": "工具结果缺失（会话中断或已被裁剪），请重新调用该工具获取数据"},
            ensure_ascii=False,
        ),
    }


def sanitize_tool_pairs(messages: list[dict]) -> list[dict]:
    """把消息序列整理成提供方要求的合法形态（否则会 400）：

    1. `tool` 消息必须紧跟其 `assistant(tool_calls)`——孤立的 `tool` 直接丢弃；
    2. `assistant(tool_calls)` 的每个 tool_call_id 都必须有对应的 `tool` 结果——
       缺失的用占位结果补齐（而不是删掉，尽量保留上下文）。

    触发场景：最近 N 条窗口把工具调用对从中间切开；或用户在工具执行中途中断会话。
    """
    out: list[dict] = []
    pending: set[str] = set()

    def flush_pending() -> None:
        for tcid in list(pending):
            out.append(_missing_tool_result(tcid))
        pending.clear()

    for m in messages:
        role = m.get("role")
        if role == "tool":
            tcid = m.get("tool_call_id") or ""
            if tcid in pending:
                out.append(m)
                pending.discard(tcid)
            # 孤立 tool（其 assistant 不在窗口内）→ 丢弃，避免 400
            continue
        if role == "assistant" and m.get("tool_calls"):
            flush_pending()  # 上一个 assistant 的结果没回全，先补齐
            out.append(m)
            for tc in m["tool_calls"]:
                tcid = tc.get("id") or ""
                if tcid:
                    pending.add(tcid)
            continue
        flush_pending()
        out.append(m)

    flush_pending()  # 末尾 assistant(tool_calls) 缺结果 → 补齐
    return out


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

    def context(self, session: Session, tool_free: bool = False) -> list[dict]:
        """构建送入模型的上下文：system 摘要（若有）+ 压缩点之后的最近消息。

        - 只保留 role/content/tool_calls/tool_call_id（剥离内部 id 等字段）
        - 上下文体积恒定：更早的内容已被摘要替代
        - 工具消息成对性由 sanitize_tool_pairs 保证（窗口裁剪/会话中断后不会 400）
        - tool_free=True：仅保留 user / 纯文本 assistant（工具序列出错时的兜底重试）
        """
        out: list[dict] = []
        if session.summary:
            out.append({
                "role": "system",
                "content": "[会话摘要（更早的对话已压缩，视为已知信息）]\n" + session.summary,
            })
        recent = [m for m in session.messages if (m.get("id") or 0) > session.compacted_until]
        if tool_free:
            recent = [
                m for m in recent
                if m.get("role") in ("user", "system")
                or (m.get("role") == "assistant" and not m.get("tool_calls"))
            ]
        else:
            recent = sanitize_tool_pairs(recent[-WINDOW:])
        for m in recent:
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

    def list_sessions(self, db: DbSession, limit: int = 50, q: str = "") -> list[dict]:
        """会话列表（置顶优先，支持标题/内容检索）。

        注意：本方法原名 `list`，会在类体作用域内遮蔽内置 `list`，
        导致后续方法注解 `list[str]` 在 Python ≤3.13 上于**导入时**抛
        TypeError: 'function' object is not subscriptable（3.14 惰性注解会掩盖该问题）。
        """
        counts = dict(
            db.query(ChatMessage.session_id, func.count(ChatMessage.id))
            .group_by(ChatMessage.session_id)
            .all()
        )
        query = db.query(ChatSession)
        if q:
            like = f"%{q}%"
            matched_ids = [
                row[0] for row in db.query(ChatMessage.session_id)
                .filter(ChatMessage.content.like(like)).distinct().all()
            ]
            query = query.filter(ChatSession.title.like(like) | ChatSession.id.in_(matched_ids or [""]))
        rows = (
            query.order_by(ChatSession.pinned.desc(), ChatSession.updated_at.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": r.id,
                "title": r.title,
                "pinned": bool(r.pinned),
                "updated_at": r.updated_at.isoformat(),
                "created_at": r.created_at.isoformat(),
                "message_count": counts.get(r.id, 0),
                "cache_hit_rate": (
                    round((r.cache_hit_tokens or 0) / ((r.cache_hit_tokens or 0) + (r.cache_miss_tokens or 0)), 4)
                    if (r.cache_hit_tokens or 0) + (r.cache_miss_tokens or 0) else 0.0
                ),
                "shared": bool(r.share_token),
            }
            for r in rows
        ]

    def rename(self, db: DbSession, session_id: str, title: str) -> dict:
        row = db.get(ChatSession, session_id)
        if row is None:
            return {"error": f"会话不存在: {session_id}"}
        row.title = (title or "").strip()[:120] or row.title
        row.updated_at = datetime.utcnow()
        db.commit()
        return {"ok": True, "id": row.id, "title": row.title}

    def set_pinned(self, db: DbSession, session_id: str, pinned: bool) -> dict:
        row = db.get(ChatSession, session_id)
        if row is None:
            return {"error": f"会话不存在: {session_id}"}
        row.pinned = bool(pinned)
        db.commit()
        return {"ok": True, "id": row.id, "pinned": row.pinned}

    def clear_messages(self, db: DbSession, session_id: str) -> dict:
        row = db.get(ChatSession, session_id)
        if row is None:
            return {"error": f"会话不存在: {session_id}"}
        n = db.query(ChatMessage).filter(ChatMessage.session_id == session_id).delete()
        row.summary = ""
        row.compacted_until = 0
        row.compact_count = 0
        row.updated_at = datetime.utcnow()
        db.commit()
        return {"ok": True, "deleted_messages": n}

    def batch_delete(self, db: DbSession, ids: list[str]) -> dict:
        deleted = 0
        for sid in ids or []:
            if self.delete(db, sid):
                deleted += 1
        return {"deleted": deleted}

    def share(self, db: DbSession, session_id: str) -> dict:
        row = db.get(ChatSession, session_id)
        if row is None:
            return {"error": f"会话不存在: {session_id}"}
        if not row.share_token:
            row.share_token = uuid.uuid4().hex[:20]
            row.share_created_at = datetime.utcnow()
            db.commit()
        return {
            "ok": True,
            "session_id": row.id,
            "token": row.share_token,
            "url": f"/share/{row.share_token}",
            "created_at": (row.share_created_at or datetime.utcnow()).isoformat(),
        }

    def revoke_share(self, db: DbSession, session_id: str) -> dict:
        row = db.get(ChatSession, session_id)
        if row is None:
            return {"error": f"会话不存在: {session_id}"}
        row.share_token = ""
        row.share_created_at = None
        db.commit()
        return {"ok": True, "session_id": row.id}

    def get_shared(self, db: DbSession, token: str) -> dict | None:
        row = db.query(ChatSession).filter(ChatSession.share_token == token).first()
        if row is None:
            return None
        session = self.get(db, row.id)
        if session is None:
            return None
        return {
            "session_id": session.id,
            "title": session.title,
            "created_at": session.created_at.isoformat(),
            "updated_at": session.updated_at.isoformat(),
            "usage": self.usage_stats(session),
            "messages": [
                {
                    "role": m.get("role"),
                    "content": m.get("content") or "",
                    "tool_calls": m.get("tool_calls") or [],
                    "tool_name": m.get("tool_name", ""),
                }
                for m in session.messages
                if m.get("role") in ("user", "assistant", "tool")
            ],
        }

    def export_markdown(self, db: DbSession, session_id: str) -> str:
        """导出为可读 Markdown（适合贴到报告/答辩材料）。"""
        s = self.get(db, session_id)
        if s is None:
            return ""
        stats = self.usage_stats(s)
        lines = [
            f"# {s.title}",
            "",
            f"- 会话 ID：`{s.id}`",
            f"- 创建时间：{s.created_at.isoformat()}",
            f"- 最后更新：{s.updated_at.isoformat()}",
            f"- 消息数：{len([m for m in s.messages if m.get('role') in ('user', 'assistant')])}",
            f"- LLM 调用：{stats['llm_calls']} 次 · 输入 {stats['prompt_tokens']} tok"
            f"（缓存命中 {stats['cache_hit_tokens']}）· 输出 {stats['completion_tokens']} tok",
            "",
            "---",
            "",
        ]
        tool_names: dict[str, str] = {}
        for m in s.messages:
            for tc in m.get("tool_calls") or []:
                if tc.get("id"):
                    tool_names[tc["id"]] = (tc.get("function") or {}).get("name", "")
        for m in s.messages:
            role = m.get("role")
            content = (m.get("content") or "").strip()
            if role == "user":
                lines += ["## 🧑 用户", "", content, ""]
            elif role == "assistant":
                if content:
                    lines += ["## 🤖 助手", "", content, ""]
                for tc in m.get("tool_calls") or []:
                    fn = tc.get("function") or {}
                    lines += [f"> 🔧 调用工具 `{fn.get('name')}`：`{fn.get('arguments', '')}`", ""]
            elif role == "tool":
                name = m.get("tool_name") or tool_names.get(m.get("tool_call_id", ""), "tool")
                snippet = content[:400].replace("\n", " ")
                lines += [f"> ↩️ `{name}` 返回：{snippet}{'…' if len(content) > 400 else ''}", ""]
        lines += ["---", "", "> 由「企业经营风险预警平台」导出；数据来自公开信源，不构成投资建议。"]
        return "\n".join(lines)

    def export_json(self, db: DbSession, session_id: str) -> dict:
        """导出为可再导入的 JSON（全保真）。"""
        s = self.get(db, session_id)
        if s is None:
            return {}
        return {
            "kind": "risk-warning-chat-session",
            "version": 1,
            "exported_at": datetime.utcnow().isoformat(),
            "title": s.title,
            "usage": self.usage_stats(s),
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

    def import_session(self, db: DbSession, data: dict) -> dict:
        """导入会话 JSON，生成新会话（保留消息与工具调用）。"""
        if not isinstance(data, dict) or data.get("kind") != "risk-warning-chat-session":
            return {"error": "不是有效的会话导出文件（kind 应为 risk-warning-chat-session）"}
        title = (data.get("title") or "导入的对话")[:120]
        existing = db.query(ChatSession).filter(ChatSession.title == title).first()
        if existing is not None:
            title = f"{title}（导入）"
        session = self.create(db, title)
        for m in data.get("messages") or []:
            if m.get("role") not in ("user", "assistant", "tool"):
                continue
            self.append(db, session, {
                "role": m["role"],
                "content": m.get("content") or "",
                "tool_calls": m.get("tool_calls") or None,
                "tool_call_id": m.get("tool_call_id", ""),
                "tool_name": m.get("tool_name", ""),
            })
        return {"ok": True, "session_id": session.id, "title": title,
                "messages": len(session.messages)}

    def delete(self, db: DbSession, session_id: str) -> bool:
        row = db.get(ChatSession, session_id)
        if row is None:
            return False
        db.query(ChatMessage).filter(ChatMessage.session_id == session_id).delete()
        db.delete(row)
        db.commit()
        return True


store = SessionStore()

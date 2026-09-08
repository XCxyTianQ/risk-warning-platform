"""会话管理（内存版；阶段4 落库并支持多设备同步）。"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Session:
    id: str
    messages: list[dict] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    title: str = "新对话"


class SessionStore:
    """进程内会话存储（原型期；重启丢失，阶段4 换 DB）。"""

    def __init__(self, window: int = 12) -> None:
        self._sessions: dict[str, Session] = {}
        self._window = window

    def create(self) -> Session:
        s = Session(id=uuid.uuid4().hex[:12])
        self._sessions[s.id] = s
        return s

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def get_or_create(self, session_id: str | None) -> Session:
        if session_id and session_id in self._sessions:
            return self._sessions[session_id]
        return self.create()

    def context(self, session: Session) -> list[dict]:
        """最近 N 条消息（上下文恒定，不随对话膨胀）。"""
        return session.messages[-self._window:]

    def append(self, session: Session, message: dict) -> None:
        session.messages.append(message)
        session.updated_at = datetime.utcnow()


store = SessionStore()

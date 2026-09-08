"""动作工具审批（对齐 Harness/Codex 的 approval 机制）。

只读工具直接执行；动作工具（写库/触发研判/拉取外部数据）先发 approval 事件，
前端确认后调用 /api/chat/approve 恢复；超时视为拒绝。
"""

import threading
import uuid
from dataclasses import dataclass, field


@dataclass
class PendingApproval:
    id: str
    session_id: str
    tool_call_id: str
    name: str
    args: dict
    description: str
    event: threading.Event = field(default_factory=threading.Event)
    approved: bool | None = None


_pending: dict[str, PendingApproval] = {}
_lock = threading.Lock()


def create(session_id: str, tool_call_id: str, name: str, args: dict, description: str) -> PendingApproval:
    pa = PendingApproval(
        id=uuid.uuid4().hex[:10],
        session_id=session_id,
        tool_call_id=tool_call_id,
        name=name,
        args=args,
        description=description,
    )
    with _lock:
        _pending[pa.id] = pa
    return pa


def get(approval_id: str) -> PendingApproval | None:
    with _lock:
        return _pending.get(approval_id)


def resolve(approval_id: str, approved: bool) -> bool:
    pa = get(approval_id)
    if pa is None or pa.event.is_set():
        return False
    pa.approved = approved
    pa.event.set()
    return True


def discard(approval_id: str) -> None:
    with _lock:
        _pending.pop(approval_id, None)

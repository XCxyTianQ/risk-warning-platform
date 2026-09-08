"""Agent 内核：事件类型与 SSE 序列化。"""

import json
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class AgentEvent:
    event: str          # token | tool | tool_result | done | error
    data: dict = field(default_factory=dict)
    ts: datetime = field(default_factory=datetime.utcnow)

    def to_sse(self) -> str:
        payload = {"ts": self.ts.isoformat(), **self.data}
        return f"event: {self.event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

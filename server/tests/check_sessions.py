# -*- coding: utf-8 -*-
"""检查会话持久化：列出会话并回放最近一个会话的消息。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=30) as c:
    sessions = c.get(f"{BASE}/api/chat/sessions").json()["sessions"]
    print(f"会话数: {len(sessions)}")
    for s in sessions[:5]:
        print(f"  - {s['title']}  | {s['message_count']} 条 | {s['updated_at'][:19]}")
    if not sessions:
        raise SystemExit(0)
    sid = sessions[0]["id"]
    data = c.get(f"{BASE}/api/chat/sessions/{sid}").json()
    print(f"\n回放会话 {sid}（{data['title']}）共 {len(data['messages'])} 条消息：")
    for m in data["messages"]:
        calls = len(m.get("tool_calls") or [])
        name = (m.get("tool_name") or "")[:22]
        content = (m.get("content") or "").replace("\n", " ")[:60]
        print(f"  {m['role']:9s} tool_calls={calls} tool={name:22s} {content!r}")

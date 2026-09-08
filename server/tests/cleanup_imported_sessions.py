# -*- coding: utf-8 -*-
r"""清理测试导入的会话副本。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=60) as c:
    for s in c.get(f"{BASE}/api/chat/sessions").json()["sessions"]:
        if "（导入）" in s["title"]:
            c.delete(f"{BASE}/api/chat/sessions/{s['id']}")
            print("已清理:", s["title"])
    print("剩余会话:", len(c.get(f"{BASE}/api/chat/sessions").json()["sessions"]))

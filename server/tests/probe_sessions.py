# -*- coding: utf-8 -*-
r"""对话管理与分享验证：搜索 / 置顶 / 重命名 / 导出 / 分享 / 导入 / 清空。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_sessions.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=120) as c:
    sessions = c.get(f"{BASE}/api/chat/sessions").json()["sessions"]
    print(f"=== 1) 会话列表（{len(sessions)} 个） ===")
    for s in sessions[:5]:
        print(f"  {'📌' if s['pinned'] else '  '} {s['title'][:24]:26s} {s['message_count']:>3} 条 | 命中 {round(s['cache_hit_rate']*100)}% | 分享 {s['shared']}")

    if not sessions:
        raise SystemExit("没有会话可测")
    sid = sessions[0]["id"]

    print("\n=== 2) 搜索（关键词：康美） ===")
    hit = c.get(f"{BASE}/api/chat/sessions", params={"q": "康美"}).json()["sessions"]
    print("命中:", [s["title"][:20] for s in hit])

    print("\n=== 3) 置顶 + 重命名 ===")
    c.patch(f"{BASE}/api/chat/sessions/{sid}", json={"pinned": True, "title": "【置顶】康美药业风险复核"})
    s = next(x for x in c.get(f"{BASE}/api/chat/sessions").json()["sessions"] if x["id"] == sid)
    print("结果:", s["title"], "| pinned:", s["pinned"], "| 是否排在首位:", c.get(f"{BASE}/api/chat/sessions").json()["sessions"][0]["id"] == sid)

    print("\n=== 4) 导出 Markdown（前 12 行） ===")
    md = c.get(f"{BASE}/api/chat/sessions/{sid}/export", params={"format": "md"}).text
    for line in md.splitlines()[:12]:
        print("  " + line)

    print("\n=== 5) 导出 JSON → 导入为新会话 ===")
    data = c.get(f"{BASE}/api/chat/sessions/{sid}/export", params={"format": "json"}).json()
    imp = c.post(f"{BASE}/api/chat/import", json={"data": data}).json()
    print("导入:", json.dumps(imp, ensure_ascii=False))

    print("\n=== 6) 分享链接 ===")
    share = c.post(f"{BASE}/api/chat/sessions/{sid}/share").json()
    print("token:", share["token"], "| url:", share["url"])
    view = c.get(f"{BASE}/api/share/{share['token']}").json()
    print("只读快照:", view["title"], "| 消息", len(view["messages"]), "条 | 用量", view["usage"]["llm_calls"], "次调用")

    print("\n=== 7) 撤销分享后访问 ===")
    c.delete(f"{BASE}/api/chat/sessions/{sid}/share")
    r = c.get(f"{BASE}/api/share/{share['token']}")
    print("HTTP", r.status_code, r.json())

    print("\n=== 8) 清理：删除导入的副本 ===")
    c.delete(f"{BASE}/api/chat/sessions/{imp['session_id']}")
    print("剩余会话:", len(c.get(f"{BASE}/api/chat/sessions").json()["sessions"]))

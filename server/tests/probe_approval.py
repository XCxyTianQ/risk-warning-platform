# -*- coding: utf-8 -*-
r"""审批机制验证：触发动作工具 → 捕获 approval 事件 → 授权 → 观察后续执行。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_approval.py
"""

import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"
MESSAGE = sys.argv[1] if len(sys.argv) > 1 else "帮我重新研判一下康美药业"

events: list[tuple[str, dict]] = []
approval_seen = threading.Event()
approval_id: dict[str, str] = {}
final_text = ""


def consume():
    global final_text
    with httpx.Client(timeout=300) as c:
        with c.stream("POST", f"{BASE}/api/chat/stream", json={"message": MESSAGE}) as r:
            event = None
            for line in r.iter_lines():
                if line.startswith("event: "):
                    event = line[7:].strip()
                elif line.startswith("data: "):
                    try:
                        data = json.loads(line[6:])
                    except ValueError:
                        continue
                    events.append((event or "?", data))
                    if event == "approval":
                        approval_id["id"] = data["approval_id"]
                        approval_seen.set()
                    elif event == "token":
                        final_text += data.get("text", "")


thread = threading.Thread(target=consume, daemon=True)
thread.start()

if approval_seen.wait(timeout=90):
    print(f"[审批] 收到授权请求 approval_id={approval_id['id']}（Agent 已暂停等待）")
    time.sleep(1)
    with httpx.Client(timeout=30) as c:
        resp = c.post(f"{BASE}/api/chat/approve", json={"approval_id": approval_id["id"], "approved": True})
        print(f"[审批] 授权结果 HTTP {resp.status_code}: {resp.json()}")
else:
    print("[审批] 未收到审批请求（可能模型未调用动作工具）")

thread.join(timeout=280)

print("-" * 70)
for ev, data in events:
    if ev == "token":
        continue
    if ev == "tool":
        print(f"[工具] {data['name']} read_only={data.get('read_only')}")
    elif ev == "approval":
        print(f"[审批请求] {data['name']} — {data['description'][:60]}…")
    elif ev == "tool_result":
        r = data.get("result", {})
        brief = {k: r[k] for k in ("ok", "score", "grade", "summary", "error") if k in r}
        print(f"[工具结果] {data['name']} -> {json.dumps(brief, ensure_ascii=False)[:200]}")
    elif ev in ("done", "error"):
        print(f"[{ev}] {json.dumps(data, ensure_ascii=False)[:120]}")
print("-" * 70)
print("最终回答:", final_text.strip()[:400])

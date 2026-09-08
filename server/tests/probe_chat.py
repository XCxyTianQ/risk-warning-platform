# -*- coding: utf-8 -*-
"""对话式研判探针：消费 SSE，打印事件摘要与最终回答。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_chat.py "康美药业现在风险怎么样？"
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.core.config import settings  # noqa: F401  (确保 .env 生效)

BASE = "http://127.0.0.1:8001"
question = sys.argv[1] if len(sys.argv) > 1 else "康美药业现在风险怎么样？简要说明依据"

events: list[tuple[str, dict]] = []
final_text = ""

with httpx.Client(timeout=180) as c:
    with c.stream("POST", f"{BASE}/api/chat/stream", json={"message": question}) as r:
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
                if event == "token":
                    final_text += data.get("text", "")

print("=" * 70)
print("问题:", question)
print("-" * 70)
for ev, data in events:
    if ev == "token":
        continue
    if ev == "tool":
        print(f"[工具调用] {data['name']}({json.dumps(data.get('args'), ensure_ascii=False)}) read_only={data.get('read_only')}")
    elif ev == "tool_result":
        res = data.get("result", {})
        print(f"[工具结果] {data['name']} -> {json.dumps(res, ensure_ascii=False)[:220]}")
    elif ev == "session":
        print(f"[会话] {data.get('session_id')}")
    elif ev == "done":
        print(f"[完成] steps={data.get('steps')}")
    elif ev == "error":
        print(f"[错误] {data.get('message')}")
print("-" * 70)
print("最终回答:\n" + final_text.strip()[:1200])

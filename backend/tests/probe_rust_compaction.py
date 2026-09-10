# -*- coding: utf-8 -*-
"""压缩（compaction）验证：把上下文窗口压到很小，强制触发压缩并检查会话仍能继续。

用法：probe_rust_compaction.py --port 8233 --turns 3
"""

import argparse
import json
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8233)
parser.add_argument("--turns", type=int, default=3)
args = parser.parse_args()

BASE = f"http://127.0.0.1:{args.port}"
questions = [
    "康美药业现在风险怎么样？",
    "它的法律合规维度为什么低？",
    "和贵州茅台比，差距主要在哪些维度？",
    "给我一句总结建议",
]

session_id = None
for turn in range(min(args.turns, len(questions))):
    question = questions[turn]
    print("=" * 66)
    print(f"第 {turn + 1} 轮：{question}")
    print("-" * 66)
    events = []
    text = ""
    t0 = time.perf_counter()
    with httpx.Client(timeout=300) as c:
        with c.stream(
            "POST",
            f"{BASE}/api/chat/stream",
            json={"message": question, "session_id": session_id},
        ) as r:
            event = None
            for line in r.iter_lines():
                if line.startswith("event: "):
                    event = line[7:].strip()
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                    events.append((event, data))
                    if event == "token":
                        text += data.get("text", "")
                    elif event == "session":
                        session_id = data.get("session_id")
    ms = int((time.perf_counter() - t0) * 1000)
    tools = [d["name"] for e, d in events if e == "tool"]
    compactions = [(d.get("phase"), d.get("folded") or d.get("reason")) for e, d in events if e == "compaction"]
    errors = [d.get("message") for e, d in events if e == "error"]
    tokens = sum(len(d.get("text", "")) for e, d in events if e == "reasoning")
    print(f"  耗时 {ms}ms | 工具 {tools} | 推理 {tokens} 字 | 回答 {len(text)} 字")
    print(f"  压缩事件：{compactions}")
    if errors:
        print(f"  ❌ 错误：{errors}")
    print(f"  回答节选：{text.strip()[:120]}".replace("\n", " "))

print("=" * 66)
with httpx.Client(timeout=30) as c:
    detail = c.get(f"{BASE}/api/chat/sessions/{session_id}").json()
    usage = c.get(f"{BASE}/api/chat/usage", params={"session_id": session_id}).json()
    msgs = detail["messages"]
    print(f"会话 {session_id}：{len(msgs)} 条消息，摘要 {len(detail.get('summary') or '')} 字")
    print(f"用量：{json.dumps(usage.get('session'), ensure_ascii=False)}")
    print(f"上下文压力：{json.dumps(usage.get('pressure'), ensure_ascii=False)}")
    print(f"消息角色序列：{[m['role'] for m in msgs]}")
    if detail.get("summary"):
        print(f"摘要节选：{detail['summary'][:150]}")

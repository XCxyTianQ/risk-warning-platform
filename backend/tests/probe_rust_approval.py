# -*- coding: utf-8 -*-
"""写操作授权（approval）端到端验证：SSE 收到 approval → POST /approve → 工具继续执行。

用法：python backend/tests/probe_rust_approval.py --port 8237 [--reject]
"""

import argparse
import json
import sys
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8237)
parser.add_argument("--reject", action="store_true", help="测试拒绝路径")
parser.add_argument("--question", default="帮我刷新康美药业（600518）的数据")
args = parser.parse_args()

BASE = f"http://127.0.0.1:{args.port}"
approve_result: dict = {}


def approve_async(approval_id: str) -> None:
    time.sleep(0.8)
    with httpx.Client(timeout=30) as c:
        r = c.post(f"{BASE}/api/chat/approve", json={"approval_id": approval_id, "approved": not args.reject})
        approve_result["status"] = r.status_code
        approve_result["body"] = r.text[:200]
    print(f"  → 已提交授权决策 approved={not args.reject}：HTTP {r.status_code}")


print("=" * 70)
print(f"问题：{args.question}（{'拒绝' if args.reject else '允许'}路径）")
print("-" * 70)
t0 = time.perf_counter()
events = []
text = ""
with httpx.Client(timeout=300) as c:
    with c.stream("POST", f"{BASE}/api/chat/stream", json={"message": args.question}) as r:
        event = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                ms = int((time.perf_counter() - t0) * 1000)
                events.append((event, data, ms))
                if event == "token":
                    text += data.get("text", "")
                elif event == "approval":
                    print(f"[{ms/1000:5.1f}s] [待授权] {data['name']} {json.dumps(data['args'], ensure_ascii=False)}")
                    print(f"          approval_id={data['approval_id']} 超时={data['timeout']}s")
                    threading.Thread(target=approve_async, args=(data["approval_id"],), daemon=True).start()

for ev, data, ms in events:
    tag = f"[{ms/1000:5.1f}s]"
    if ev == "tool":
        print(f"{tag} [工具] {data['name']} read_only={data.get('read_only')}")
    elif ev == "tool_result":
        print(f"{tag} [结果] {data['name']} {data.get('latency_ms')}ms -> {json.dumps(data.get('result'), ensure_ascii=False)[:160]}")
    elif ev == "usage":
        t = data.get("timing", {})
        print(f"{tag} [用量] {t.get('latency_ms')}ms {t.get('completion_tokens')}tok 缓存命中 {data.get('cache_hit_rate')}")
    elif ev == "done":
        print(f"{tag} [完成] steps={data.get('steps')}")
    elif ev == "error":
        print(f"{tag} [错误] {data.get('message')}")

print("-" * 70)
print("回答节选：", text.strip()[:200].replace("\n", " "))
print("授权接口：", approve_result)
kinds = [e for e, _, _ in events]
print(f"事件序列摘要：approval×{kinds.count('approval')} tool×{kinds.count('tool')} "
      f"tool_result×{kinds.count('tool_result')} done×{kinds.count('done')} error×{kinds.count('error')}")

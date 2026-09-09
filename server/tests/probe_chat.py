# -*- coding: utf-8 -*-
"""对话式研判探针：消费 SSE，打印事件摘要、耗时分解与最终回答。

用法（server 目录）：
    .venv\\Scripts\\python.exe tests\\probe_chat.py "康美药业现在风险怎么样？"
    .venv\\Scripts\\python.exe tests\\probe_chat.py "..." --quiet   # 只打印耗时汇总
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# 控制台编码兜底：Windows 默认 GBK，模型输出含 ✓/≈ 等字符会抛 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

from app.core.config import settings  # noqa: F401  (确保 .env 生效)

BASE = "http://127.0.0.1:8001"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
quiet = "--quiet" in sys.argv
question = args[0] if args else "康美药业现在风险怎么样？简要说明依据"

events: list[tuple[str, dict, int]] = []
final_text = ""
llm_calls: list[dict] = []
tool_calls: list[dict] = []
reasoning_chars = 0
t0 = time.perf_counter()
ttfb_ms: int | None = None

with httpx.Client(timeout=300) as c:
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
                elapsed = int((time.perf_counter() - t0) * 1000)
                if ttfb_ms is None:
                    ttfb_ms = elapsed
                events.append((event or "?", data, elapsed))
                if event == "token":
                    final_text += data.get("text", "")
                elif event == "reasoning":
                    reasoning_chars += len(data.get("text", ""))
                elif event == "usage" and data.get("timing"):
                    llm_calls.append({**data.get("timing", {}), "prompt": data.get("call", {}).get("prompt_tokens")})
                elif event == "tool_result" and data.get("latency_ms") is not None:
                    tool_calls.append({"name": data.get("name"), "ms": data["latency_ms"]})

total_ms = int((time.perf_counter() - t0) * 1000)

print("=" * 70)
print("问题:", question)
print("-" * 70)
if not quiet:
    for ev, data, ms in events:
        if ev in ("token", "reasoning"):
            continue
        tag = f"[{ms/1000:6.1f}s]"
        if ev == "tool":
            print(f"{tag} [工具调用] {data['name']}({json.dumps(data.get('args'), ensure_ascii=False)}) read_only={data.get('read_only')}")
        elif ev == "tool_result":
            res = data.get("result", {})
            print(f"{tag} [工具结果] {data['name']} ({data.get('latency_ms')}ms) -> {json.dumps(res, ensure_ascii=False)[:180]}")
        elif ev == "session":
            print(f"{tag} [会话] {data.get('session_id')}")
        elif ev == "usage" and data.get("timing"):
            t = data["timing"]
            print(f"{tag} [模型] {t['latency_ms']}ms（首字 {t['ttft_ms']}ms, {t['completion_tokens']} tok, "
                  f"{t['tokens_per_sec']} tok/s, 推理 {t['reasoning_chars']} 字）")
        elif ev == "done":
            print(f"{tag} [完成] steps={data.get('steps')}")
        elif ev == "error":
            print(f"{tag} [错误] {data.get('message')}")

print("-" * 70)
print("== 耗时分解 ==")
print(f"  端到端: {total_ms} ms | 首个事件: {ttfb_ms} ms")
print(f"  模型调用: {len(llm_calls)} 次，合计 {sum(c['latency_ms'] for c in llm_calls)} ms "
      f"（首字合计 {sum(c['ttft_ms'] for c in llm_calls)} ms）")
for i, c in enumerate(llm_calls, 1):
    print(f"    #{i}: {c['latency_ms']}ms 首字{c['ttft_ms']}ms {c['completion_tokens']}tok "
          f"{c['tokens_per_sec']}tok/s 推理{c['reasoning_chars']}字 prompt={c.get('prompt')}")
print(f"  工具调用: {len(tool_calls)} 次，合计 {sum(t['ms'] for t in tool_calls)} ms")
for t in tool_calls:
    print(f"    {t['name']}: {t['ms']}ms")
print(f"  推理内容: {reasoning_chars} 字")
print(f"  最终回答: {len(final_text)} 字")
if not quiet:
    print("-" * 70)
    print("最终回答:\n" + final_text.strip()[:1200])

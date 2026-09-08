# -*- coding: utf-8 -*-
r"""缓存命中与压缩验证：多轮对话观察命中率，低阈值强制压缩观察压缩链路。

用法（server 目录）：
  .venv\Scripts\python.exe tests\probe_cache.py            # 3 轮对话，看命中率
  .venv\Scripts\python.exe tests\probe_cache.py compact    # 用低阈值触发压缩
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# 压缩测试：把窗口压小、阈值调低，几轮内必然触发
if len(sys.argv) > 1 and sys.argv[1] == "compact":
    os.environ["LLM_CONTEXT_WINDOW"] = "3000"
    os.environ["COMPACTION_THRESHOLD_RATIO"] = "0.5"
    os.environ["COMPACTION_RETAIN_RATIO"] = "0.1"

import httpx

BASE = "http://127.0.0.1:8001"
QUESTIONS = [
    "贵州茅台风险怎么样？",
    "那它的舆情呢？",
    "康美药业和它比呢？",
    "平台整体情况怎么样？",
]


def ask(client: httpx.Client, question: str, session_id: str | None):
    usage = None
    events = []
    with client.stream("POST", f"{BASE}/api/chat/stream",
                       json={"message": question, "session_id": session_id}, timeout=300) as r:
        event = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                if event == "usage":
                    usage = data
                elif event == "compaction":
                    events.append(data)
                elif event == "session":
                    session_id = data["session_id"]
    return session_id, usage, events


with httpx.Client() as c:
    sid = None
    for i, q in enumerate(QUESTIONS, 1):
        sid, usage, comps = ask(c, q, sid)
        if usage:
            print(f"第 {i} 轮 | 输入 {usage['prompt_tokens']:>6} tok | 缓存命中 {usage['cache_hit_tokens']:>6} "
                  f"| 未命中 {usage['cache_miss_tokens']:>6} | 命中率 {usage['cache_hit_rate']*100:5.1f}% "
                  f"| 输出 {usage['completion_tokens']:>5} | 累计 ¥{usage['est_cost']:.4f} "
                  f"| 压缩 {usage['compact_count']} 次")
        else:
            print(f"第 {i} 轮 | 无 usage 返回")
        for cp in comps:
            print(f"   [压缩] {cp.get('phase')} {cp.get('folded', '')} {cp.get('reason', '')}")
    print("\n最终会话用量:", c.get(f"{BASE}/api/chat/sessions/{sid}").json()["usage"])

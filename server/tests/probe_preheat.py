# -*- coding: utf-8 -*-
r"""预热效果验证：预热 → 新会话首个请求的缓存命中情况。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_preheat.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"


def first_turn_usage(question: str) -> dict | None:
    """新会话发一句，返回首个 LLM 调用的 usage。"""
    with httpx.Client(timeout=300) as c:
        usage = None
        with c.stream("POST", f"{BASE}/api/chat/stream", json={"message": question}) as r:
            event = None
            for line in r.iter_lines():
                if line.startswith("event: "):
                    event = line[7:].strip()
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                    if event == "usage" and usage is None:
                        usage = data.get("call")
                    elif event == "done":
                        break
        return usage


with httpx.Client(timeout=60) as c:
    print("=== 预热状态（预热前） ===")
    before = c.get(f"{BASE}/api/chat/usage").json()["preheat"]
    print(json.dumps(before, ensure_ascii=False, indent=2))

    print("\n=== 触发一次预热（等待启动预热或手动触发） ===")
    # 启动预热是后台线程，等它就绪；TTL 内不会重复
    import time

    for _ in range(30):
        st = c.get(f"{BASE}/api/chat/usage").json()["preheat"]
        if st.get("last_warm_ago") is not None:
            print("预热已完成:", json.dumps(st, ensure_ascii=False))
            break
        time.sleep(1)

    print("\n=== 新会话首个请求的缓存命中 ===")
    usage = first_turn_usage("贵州茅台风险怎么样？")
    if usage:
        total = (usage.get("cache_hit_tokens", 0) + usage.get("cache_miss_tokens", 0)) or 1
        print(f"输入 {usage['prompt_tokens']} tok | 命中 {usage['cache_hit_tokens']} | "
              f"未命中 {usage['cache_miss_tokens']} | 命中率 {usage['cache_hit_tokens']/total*100:.1f}%")
    else:
        print("未收到 usage 事件")

    print("\n=== 预热状态（预热后） ===")
    print(json.dumps(c.get(f"{BASE}/api/chat/usage").json()["preheat"], ensure_ascii=False, indent=2))

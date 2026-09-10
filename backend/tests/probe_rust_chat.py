# -*- coding: utf-8 -*-
"""Rust 后端 P1 验证：SSE 对话（真实模型 + 工具调用）+ 会话持久化 + 金标准比对。

用法：python backend/tests/probe_rust_chat.py [--rust-port 8232] [--py-port 8001]
"""

import argparse
import json
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--rust-port", type=int, default=8232)
parser.add_argument("--py-port", type=int, default=8001)
parser.add_argument("--question", default="康美药业现在风险怎么样？简要说明依据")
args = parser.parse_args()

RUST = f"http://127.0.0.1:{args.rust_port}"
PY = f"http://127.0.0.1:{args.py_port}"

print("=" * 70)
print("一、Rust 后端 SSE 对话（真实模型）")
print("-" * 70)
events = []
text = ""
reasoning_chars = 0
t0 = time.perf_counter()
with httpx.Client(timeout=300) as c:
    with c.stream("POST", f"{RUST}/api/chat/stream", json={"message": args.question}) as r:
        if r.status_code != 200:
            print("HTTP", r.status_code, r.read()[:300])
            raise SystemExit(1)
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
                elif event == "reasoning":
                    reasoning_chars += len(data.get("text", ""))
total_ms = int((time.perf_counter() - t0) * 1000)

session_id = None
for ev, data, ms in events:
    tag = f"[{ms/1000:5.1f}s]"
    if ev == "session":
        session_id = data.get("session_id")
        print(f"{tag} [会话] {session_id}")
    elif ev == "tool":
        print(f"{tag} [工具] {data['name']}({json.dumps(data.get('args'), ensure_ascii=False)})")
    elif ev == "tool_result":
        print(f"{tag} [结果] {data['name']} {data.get('latency_ms')}ms -> {json.dumps(data.get('result'), ensure_ascii=False)[:120]}")
    elif ev == "usage":
        t = data.get("timing", {})
        print(f"{tag} [用量] {t.get('latency_ms')}ms 首字{t.get('ttft_ms')}ms {t.get('completion_tokens')}tok "
              f"{t.get('tokens_per_sec')}tok/s 推理{t.get('reasoning_chars')}字 缓存命中{data.get('cache_hit_rate')}")
    elif ev == "done":
        print(f"{tag} [完成] steps={data.get('steps')}")
    elif ev == "error":
        print(f"{tag} [错误] {data.get('message')}")

print(f"\n端到端 {total_ms}ms | 工具调用 {sum(1 for e in events if e[0]=='tool')} 次 | 推理 {reasoning_chars} 字")
print("回答节选：", text.strip()[:200].replace("\n", " "))

print()
print("=" * 70)
print("二、会话持久化")
print("-" * 70)
with httpx.Client(timeout=30) as c:
    sessions = c.get(f"{RUST}/api/chat/sessions").json()["sessions"]
    print(f"会话数：{len(sessions)}")
    if sessions:
        print(f"  最新：{sessions[0]['title']}（{sessions[0]['message_count']} 条消息）")
    if session_id:
        detail = c.get(f"{RUST}/api/chat/sessions/{session_id}").json()
        roles = [m["role"] for m in detail["messages"]]
        print(f"  会话 {session_id} 消息角色：{roles}")
        usage = c.get(f"{RUST}/api/chat/usage", params={"session_id": session_id}).json()
        print(f"  用量：{json.dumps(usage.get('session'), ensure_ascii=False)}")
        print(f"  上下文压力：{json.dumps(usage.get('pressure'), ensure_ascii=False)}")

print()
print("=" * 70)
print("三、金标准比对：六维评分 Rust vs Python")
print("-" * 70)
with httpx.Client(timeout=60) as c:
    try:
        rust_sum = c.get(f"{RUST}/api/dashboard/summary").json()
    except Exception as exc:  # noqa: BLE001
        print("Rust summary 获取失败：", exc)
        raise SystemExit(0)
    try:
        py_sum = c.get(f"{PY}/api/dashboard/summary").json()
    except Exception as exc:  # noqa: BLE001
        print("Python summary 获取失败（跳过比对）：", exc)
        py_sum = None

rust_map = {e["name"]: e for e in rust_sum["enterprises"]}
print(f"Rust：{rust_sum['enterprise_total']} 家，平均 {rust_sum['avg_score']}，等级分布 {rust_sum['level_counts']}")
for name, e in rust_map.items():
    dims = e.get("dimension_scores", {})
    print(f"  {name[:18]:<20} {e['score']} {e['grade']} {e['level']} "
          f"{ {k: v for k, v in dims.items()} }")

if py_sum:
    py_map = {e["name"]: e for e in py_sum["enterprises"]}
    print(f"\nPython：{py_sum['enterprise_total']} 家，平均 {py_sum['avg_score']}，等级分布 {py_sum['level_counts']}")
    diffs = []
    for name, re_ in rust_map.items():
        pe = py_map.get(name)
        if pe is None:
            diffs.append(f"{name}: Python 缺失")
            continue
        if re_["score"] != pe["score"]:
            diffs.append(f"{name}: 综合分 Rust={re_['score']} Python={pe['score']}")
        for dim, rv in (re_.get("dimension_scores") or {}).items():
            pv = (pe.get("dimension_scores") or {}).get(dim)
            if rv != pv:
                diffs.append(f"{name}.{dim}: Rust={rv} Python={pv}")
    if diffs:
        print(f"\n❌ 差异 {len(diffs)} 处：")
        for d in diffs[:20]:
            print("   " + d)
    else:
        print("\n✅ 金标准一致：全部企业综合分与六维分逐项相同")

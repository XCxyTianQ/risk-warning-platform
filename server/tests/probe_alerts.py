# -*- coding: utf-8 -*-
r"""预警中心闭环验证：生成 → 列表 → 处置流转 → 报告。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_alerts.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=120) as c:
    print("=== 1) 生成预警（全量） ===")
    r = c.post(f"{BASE}/api/alerts/generate", json={})
    print(r.json())

    print("\n=== 2) 预警汇总 ===")
    print(c.get(f"{BASE}/api/alerts/summary").json())

    print("\n=== 3) 待处理列表 ===")
    pend = c.get(f"{BASE}/api/alerts", params={"status": "pending"}).json()
    print("待处理条数:", pend["total"])
    for a in pend["items"][:6]:
        print(f"  #{a['id']} [{a['level']:6s}] {a['enterprise'][:14]:16s} {a['dimension_label']:6s} {a['title'][:34]}")

    if not pend["items"]:
        raise SystemExit("没有待处理预警")

    target = pend["items"][0]
    print(f"\n=== 4) 处置流程：#{target['id']} ===")
    for action in ("start", "resolve"):
        resp = c.post(f"{BASE}/api/alerts/{target['id']}/handle",
                      json={"action": action, "handler": "张三", "note": f"演示：{action}"})
        print(f"  {action:8s} -> HTTP {resp.status_code} {resp.json().get('status_label')}")

    print("\n=== 5) 预警报告（前 30 行） ===")
    rep = c.get(f"{BASE}/api/alerts/{target['id']}/report")
    for line in rep.text.splitlines()[:30]:
        print("  " + line)

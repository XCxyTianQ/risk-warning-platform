# -*- coding: utf-8 -*-
r"""假企业校验 + 无数据评分验证。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_fake_enterprise.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=300) as c:
    print("=== 1) 尝试添加虚假企业「中色集团」 ===")
    r = c.post(f"{BASE}/api/enterprises", json={"name": "中色集团", "auto_fetch": True})
    print("HTTP", r.status_code)
    print(r.json())

    print("\n=== 2) 尝试添加真实企业「三一重工」（应成功） ===")
    r2 = c.post(f"{BASE}/api/enterprises", json={"name": "三一重工", "auto_fetch": True})
    print("HTTP", r2.status_code)
    body = r2.json()
    print("企业:", body.get("name"), "| 代码:", body.get("stock_code"), "| id:", body.get("enterprise_id"))
    for dim, info in (body.get("refresh") or {}).get("dimensions", {}).items():
        print(f"  {dim:8s} {'✅ +' + str(info.get('inserted', 0)) if info.get('ok') else '⚠️ ' + (info.get('gap') or info.get('error') or '')}")

    print("\n=== 3) 现有企业评分（无数据的应显示「— / 无法评估」） ===")
    for e in c.get(f"{BASE}/api/enterprises").json()["items"]:
        snap = c.get(f"{BASE}/api/enterprise/{e['id']}/risk").json()
        print(f"  {e['name'][:22]:24s} 评分={str(snap.get('score')):>6s} 评级={snap.get('grade'):>3s} 等级={snap.get('verdict_level')}")

# -*- coding: utf-8 -*-
r"""自由添加企业 + 多信源验证：解析代码 → 创建 → 自动拉取 → 评分。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_add_enterprise.py [企业名]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"
name = sys.argv[1] if len(sys.argv) > 1 else "比亚迪"

with httpx.Client(timeout=300) as c:
    print("=== 1) 数据源状态 ===")
    for s in c.get(f"{BASE}/api/datasources").json()["sources"]:
        print(f"  {s['dimension']:8s} [{s['mode']}] " + ", ".join(x["name"] for x in s["sources"]))

    print(f"\n=== 2) 解析股票代码：{name} ===")
    cands = c.get(f"{BASE}/api/resolve_stock", params={"name": name}).json()["candidates"]
    for x in cands[:5]:
        print(f"  {x['code']}  {x['name']}")
    if not cands:
        raise SystemExit("未匹配到代码")

    print(f"\n=== 3) 创建企业并自动拉取 ===")
    r = c.post(f"{BASE}/api/enterprises", json={"name": cands[0]["name"], "stock_code": cands[0]["code"], "auto_fetch": True})
    print("HTTP", r.status_code)
    data = r.json()
    print("企业 id:", data.get("enterprise_id"), "| 代码:", data.get("stock_code"))
    for dim, info in (data.get("refresh") or {}).get("dimensions", {}).items():
        if info.get("ok"):
            print(f"  {dim:8s} ✅ 拉取 {info.get('fetched', 0)} 条（新增 {info.get('inserted', 0)} / 更新 {info.get('updated', 0)}）来源 {info.get('source')}")
        else:
            print(f"  {dim:8s} ⚠️ {info.get('gap') or info.get('error')}")

    eid = data["enterprise_id"]
    print("\n=== 4) 新企业风险画像 ===")
    snap = c.get(f"{BASE}/api/enterprise/{eid}/risk").json()
    print("综合评分:", snap.get("score"), "| 评级:", snap.get("grade"), "| 等级:", snap.get("verdict_level"))
    for dim, info in snap.get("dimensions", {}).items():
        print(f"  {info.get('label', dim):8s} {info.get('score')} 分 | {(info.get('note') or '')[:60]}")

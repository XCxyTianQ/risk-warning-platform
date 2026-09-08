# -*- coding: utf-8 -*-
r"""数据源刷新验证：调用 /api/enterprise/{id}/refresh 看各维度拉取结果。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_refresh.py 600519
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"
key = sys.argv[1] if len(sys.argv) > 1 else "600519"

with httpx.Client(timeout=300) as c:
    ents = c.get(f"{BASE}/api/enterprises").json()["items"]
    target = next(
        (e for e in ents if key in e["name"] or key == str(e.get("id")) or key == e.get("stock_code")),
        None,
    )
    if target is None:
        print("未找到企业:", key, "| 现有:", [e["name"] for e in ents])
        raise SystemExit(1)
    eid = target["id"]
    print(f"刷新企业: {target['name']} (id={eid})")
    r = c.post(f"{BASE}/api/enterprise/{eid}/refresh")
    print("HTTP", r.status_code)
    data = r.json()
    print("股票代码:", data.get("enterprise", {}).get("stock_code") or "（无）")
    for dim, info in data.get("dimensions", {}).items():
        if info.get("ok"):
            print(f"  {dim:8s} ✅ 拉取 {info['fetched']} 条 | 新增 {info['inserted']} | 更新 {info['updated']} | 来源 {info['source']}")
        else:
            print(f"  {dim:8s} ⚠️ {info.get('gap') or info.get('error')}")
    print("\n--- 刷新后风险快照 ---")
    snap = c.get(f"{BASE}/api/enterprise/{eid}/risk").json()
    print("综合评分:", snap.get("score"), "| 评级:", snap.get("grade"), "| 等级:", snap.get("verdict_level"))
    for dim, info in snap.get("dimensions", {}).items():
        print(f"  {info.get('label', dim):8s} {info.get('score')} 分 | {info.get('note', '')[:70]}")

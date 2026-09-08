# -*- coding: utf-8 -*-
r"""清理测试产生的重复项，并验证"内容一致则复用"逻辑。

用法（server 目录）：.venv\Scripts\python.exe tests\cleanup_and_verify_bundle.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=120) as c:
    # 1) 清理上一轮测试产生的「（导入N）」条目
    for p in c.get(f"{BASE}/api/plugins/presets").json()["items"]:
        if "导入" in p["name"]:
            c.delete(f"{BASE}/api/plugins/presets/{p['id']}")
    for s in c.get(f"{BASE}/api/skills").json()["items"]:
        if "导入" in s["name"]:
            c.delete(f"{BASE}/api/skills/{s['id']}")
    print("清理完成")

    # 2) 导出 → 再次导入（技能内容一致，应复用而非重复）
    preset = next(p for p in c.get(f"{BASE}/api/plugins/presets").json()["items"] if p["name"] == "合规审查专员")
    bundle = c.get(f"{BASE}/api/plugins/presets/{preset['id']}/export").json()
    r = c.post(f"{BASE}/api/plugins/import", json={"data": bundle, "strategy": "rename"}).json()
    print("重复导入结果:", json.dumps(r, ensure_ascii=False))
    print("当前预设:", [p["name"] for p in c.get(f"{BASE}/api/plugins/presets").json()["items"]])
    print("当前技能数:", c.get(f"{BASE}/api/skills").json()["total"])

    # 3) 清理这次产生的预设副本
    for p in c.get(f"{BASE}/api/plugins/presets").json()["items"]:
        if "导入" in p["name"]:
            c.delete(f"{BASE}/api/plugins/presets/{p['id']}")
    print("收尾完成，预设:", [p["name"] for p in c.get(f"{BASE}/api/plugins/presets").json()["items"]])

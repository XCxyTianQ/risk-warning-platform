# -*- coding: utf-8 -*-
r"""预设导入/导出验证：导出单个预设 → 改包名导入（rename）→ 导出全部。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_bundle.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=120) as c:
    presets = c.get(f"{BASE}/api/plugins/presets").json()["items"]
    target = next(p for p in presets if p["name"] == "合规审查专员")

    print("=== 1) 导出单个预设 ===")
    bundle = c.get(f"{BASE}/api/plugins/presets/{target['id']}/export").json()
    print("kind:", bundle["kind"], "| version:", bundle["version"])
    print("包含：预设", [p["name"] for p in bundle["presets"]],
          "| 技能", [s["name"] for s in bundle["skills"]],
          "| 插件", [t["name"] for t in bundle["tools"]])

    print("\n=== 2) 改包内预设名后导入（strategy=rename） ===")
    bundle["presets"][0]["name"] = "合规审查专员"
    r = c.post(f"{BASE}/api/plugins/import", json={"data": bundle, "strategy": "rename"}).json()
    print("导入结果:", json.dumps(r, ensure_ascii=False))

    print("\n=== 3) 再导入一次（strategy=skip，应全部跳过） ===")
    r2 = c.post(f"{BASE}/api/plugins/import", json={"data": bundle, "strategy": "skip"}).json()
    print("导入结果:", json.dumps(r2, ensure_ascii=False))

    print("\n=== 4) 导出全部 ===")
    allb = c.get(f"{BASE}/api/plugins/export").json()
    print("预设:", [p["name"] for p in allb["presets"]])
    print("技能:", len(allb["skills"]), "个 | 插件:", len(allb["tools"]), "个")

    print("\n=== 5) 非法包（错误处理） ===")
    bad = c.post(f"{BASE}/api/plugins/import", json={"data": {"kind": "wrong"}, "strategy": "rename"})
    print("HTTP", bad.status_code, bad.json())

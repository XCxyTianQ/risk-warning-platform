# -*- coding: utf-8 -*-
r"""桌面端后端模式验证：静态托管 + SPA fallback + 数据目录。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_desktop_backend.py [端口]
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
BASE = f"http://127.0.0.1:{PORT}"

with httpx.Client(timeout=20) as c:
    print("=== /api/health ===")
    print(c.get(f"{BASE}/api/health").json())

    home = c.get(f"{BASE}/")
    print(f"=== 首页 === HTTP {home.status_code} | 含 Vue 挂载点: {'<div id=\"app\">' in home.text}")

    spa = c.get(f"{BASE}/enterprises")
    print(f"=== SPA 路由 /enterprises === HTTP {spa.status_code} | 回退到 index.html: {'<div id=\"app\">' in spa.text}")

    api = c.get(f"{BASE}/api/enterprises")
    print(f"=== API /api/enterprises === HTTP {api.status_code} | 企业数: {api.json()['total']}")

    asset = c.get(f"{BASE}/assets/{os.listdir(r'E:\IUC\risk-warning-platform\web\dist\assets')[0]}")
    print(f"=== 静态资源 === HTTP {asset.status_code} | {len(asset.content)} bytes")

    data_dir = r"E:\IUC\rwp-desktop-test"
    if os.path.isdir(data_dir):
        print(f"=== 数据目录 {data_dir} ===", os.listdir(data_dir))

# -*- coding: utf-8 -*-
r"""MCP 接入验证：注册外部 mock 服务 → 同步工具 → 通过 Agent 调用。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_mcp.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=120) as c:
    print("=== 1) 注册外部 MCP 服务 ===")
    r = c.post(f"{BASE}/api/mcp/servers", json={"name": "mock-mcp", "url": "http://127.0.0.1:8765/mcp"})
    print("HTTP", r.status_code, json.dumps(r.json(), ensure_ascii=False)[:260])

    print("\n=== 2) 服务列表 ===")
    for s in c.get(f"{BASE}/api/mcp/servers").json()["items"]:
        names = [t["name"] for t in s["tools"]]
        print(f"  #{s['id']} {s['name']} | 状态 {s['status']} | 工具 {s['tool_count']}: {names}")

    print("\n=== 3) 本平台对外暴露的 MCP 工具数 ===")
    tools = c.post(f"{BASE}/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).json()["result"]["tools"]
    print(f"  共 {len(tools)} 个：{[t['name'] for t in tools][:6]} ...")

    print("\n=== 4) 通过 MCP 调用外部工具（echo） ===")
    sid = c.get(f"{BASE}/api/mcp/servers").json()["items"][0]["id"]
    out = c.post(f"{BASE}/api/mcp", json={
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "get_platform_overview", "arguments": {}},
    }).json()
    print("  ", out["result"]["content"][0]["text"][:160])

# -*- coding: utf-8 -*-
r"""预设与插件验证：内置预设 → 手搓一个 HTTP 插件 → 用预设限定工具跑一轮对话。

用法（server 目录）：.venv\Scripts\python.exe tests\probe_presets.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

BASE = "http://127.0.0.1:8001"

with httpx.Client(timeout=300) as c:
    print("=== 1) 内置预设 ===")
    for p in c.get(f"{BASE}/api/plugins/presets").json()["items"]:
        tools = p["tools"] or ["（全部）"]
        print(f"  #{p['id']} {p['name']} | 工具 {len(p['tools'])} 个 | 技能 {p['skills'] or ['（全部）']}")

    print("\n=== 2) 手搓一个 HTTP 插件（调用本地 mock MCP 的 echo 不可用，改用 httpbin 风格本地接口） ===")
    # 用平台自身接口作为插件目标，验证声明式 HTTP 调用链路
    body = {
        "name": "platform_health",
        "description": "查询平台健康状态（示例插件：调用本平台 /api/health）",
        "parameters": {"type": "object", "properties": {}},
        "method": "GET",
        "url": "http://127.0.0.1:8001/api/health",
    }
    r = c.post(f"{BASE}/api/plugins/tools", json=body)
    print("创建:", r.status_code, r.json())

    tools = c.get(f"{BASE}/api/plugins/tools").json()["items"]
    tid = tools[-1]["id"]
    print("测试调用:", c.post(f"{BASE}/api/plugins/tools/{tid}/test", json={}).json())

    print("\n=== 3) 用「合规审查专员」预设跑一轮（工具白名单生效） ===")
    preset = next(p for p in c.get(f"{BASE}/api/plugins/presets").json()["items"] if p["name"] == "合规审查专员")
    events = []
    with c.stream("POST", f"{BASE}/api/chat/stream",
                  json={"message": "康美药业合规风险如何？", "preset_id": preset["id"]}, timeout=300) as resp:
        event = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                if event == "tool":
                    events.append(data["name"])
                if event == "done":
                    break
    print("本轮调用的工具:", events)
    print("（白名单应只包含：search_enterprise / get_score_profile / get_risk_facts / list_skills / load_skill / get_alert_report）")

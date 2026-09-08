# -*- coding: utf-8 -*-
"""探测各模型对 function calling 的支持（Agent 链路前置条件）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_tools.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.core.config import settings

BASE = settings.llm_base_url.rstrip("/")
HEADERS = {"Authorization": f"Bearer {settings.llm_api_key}"}

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_news",
        "description": "获取企业舆情新闻",
        "parameters": {"type": "object", "properties": {"enterprise": {"type": "string"}}},
    },
}]

MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp", "deepseek-chat"]

with httpx.Client(timeout=120) as c:
    for model in MODELS:
        try:
            r = c.post(
                BASE + "/chat/completions",
                headers=HEADERS,
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "请调用工具查询杭州深度求索的舆情新闻。"}],
                    "tools": TOOLS,
                    "tool_choice": "auto",
                    "max_tokens": 512,
                },
            )
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            err = body.get("error")
            msg = (body.get("choices") or [{}])[0].get("message", {}) if isinstance(body, dict) else {}
            tc = msg.get("tool_calls")
            if err:
                print(f"{model:34s} HTTP {r.status_code} | 错误: {str(err)[:160]}")
            elif tc:
                names = [t.get("function", {}).get("name") for t in tc]
                print(f"{model:34s} HTTP {r.status_code} | ✅ 支持工具调用 tool_calls={names}")
            else:
                print(f"{model:34s} HTTP {r.status_code} | ⚠️ 未返回 tool_calls | content={str(msg.get('content'))[:80]!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"{model:34s} 异常: {exc}")

# -*- coding: utf-8 -*-
"""LLM 连通性自检：列出可用模型 + 逐个最小对话测试（不回显 Key）。

用法（在 server 目录）：.venv\\Scripts\\python.exe tests\\check_llm.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # 允许直接运行

import httpx

from app.core.config import settings

BASE = settings.llm_base_url.rstrip("/")
HEADERS = {"Authorization": f"Bearer {settings.llm_api_key}"}

print(f"base_url = {BASE}")
print(f"配置模型 = {settings.llm_model}")
print(f"Key      = {settings.llm_api_key[:6]}***{settings.llm_api_key[-4:]} (长度 {len(settings.llm_api_key)})")
print("-" * 60)

with httpx.Client(timeout=60) as c:
    r = c.get(BASE + "/models", headers=HEADERS)
    print(f"GET /models -> HTTP {r.status_code}")
    models = []
    if r.status_code == 200:
        try:
            models = [m.get("id") for m in r.json().get("data", [])]
            print("可用模型:", models)
        except Exception as exc:  # noqa: BLE001
            print("解析失败:", exc, r.text[:200])
    else:
        print("响应:", r.text[:300])

    targets = []
    for m in [settings.llm_model] + list(models) + ["deepseek-chat", "deepseek-reasoner"]:
        if m and m not in targets:
            targets.append(m)

    for model in targets:
        try:
            r2 = c.post(
                BASE + "/chat/completions",
                headers=HEADERS,
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "只回复两个字：连通"}],
                    "max_tokens": 300,
                },
            )
            ok = r2.headers.get("content-type", "").startswith("application/json")
            body = r2.json() if ok else {}
            msg = (body.get("choices") or [{}])[0].get("message", {}) if isinstance(body, dict) else {}
            content = msg.get("content")
            usage = body.get("usage") if isinstance(body, dict) else None
            err = body.get("error") if isinstance(body, dict) else None
            print(f"chat[{model}] -> HTTP {r2.status_code} | content={content!r} | usage={usage} | error={err}")
        except Exception as exc:  # noqa: BLE001
            print(f"chat[{model}] 异常: {exc}")

# -*- coding: utf-8 -*-
"""多模态能力验证：把表格截图交给视觉模型，要求结构化提取。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_vision.py [图片路径]
"""

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.core.config import settings

img = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "data" / "samples" / "finance_table_demo.png"
b64 = base64.b64encode(img.read_bytes()).decode()

BASE = settings.llm_base_url.rstrip("/")
payload = {
    "model": settings.llm_model,
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "这是一张财务表格截图。请只输出 JSON：{\"company\":\"...\",\"year\":\"...\",\"revenue\":数字,\"net_profit\":数字,\"total_assets\":数字,\"debt_ratio\":数字}，单位万元，负数保留负号。"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ],
    }],
    "max_tokens": 1024,
}

with httpx.Client(timeout=180) as c:
    r = c.post(BASE + "/chat/completions", headers={"Authorization": f"Bearer {settings.llm_api_key}"}, json=payload)
    print("HTTP", r.status_code)
    body = r.json()
    if body.get("error"):
        print("错误:", body["error"])
        raise SystemExit(1)
    msg = (body.get("choices") or [{}])[0].get("message", {})
    print("模型:", settings.llm_model)
    print("usage:", body.get("usage"))
    print("原始输出:", msg.get("content"))

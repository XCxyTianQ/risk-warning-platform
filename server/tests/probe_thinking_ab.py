# -*- coding: utf-8 -*-
"""A/B 对比：默认（带思考）vs thinking=disabled，量化模型侧耗时差异。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_thinking_ab.py
"""

import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

from app.core.config import settings
from app.db.database import SessionLocal, init_db
from app.services.settings_store import load_and_apply

init_db()
db = SessionLocal()
load_and_apply(db)

url = settings.llm_base_url.rstrip("/") + "/chat/completions"
headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
QUESTION = (
    "翔鹭钨业(002842)与章源钨业(002378)的毛利率分别在 14%、16% 左右，明显低于制造业平均。"
    "请分析可能原因（3 条），并给出如何用财报验证每一条的检查方法。控制在 300 字内。"
)

for label, extra in (("默认（带思考）", {}), ("thinking=disabled", {"thinking": {"type": "disabled"}})):
    body = {
        "model": settings.llm_model,
        "messages": [{"role": "user", "content": QUESTION}],
        "max_tokens": 1200,
        **extra,
    }
    t0 = time.perf_counter()
    with httpx.Client(timeout=180) as c:
        r = c.post(url, json=body, headers=headers)
    ms = int((time.perf_counter() - t0) * 1000)
    if r.status_code != 200:
        print(f"[{label}] FAIL {r.status_code} {r.text[:200]}")
        continue
    d = r.json()
    usage = d.get("usage") or {}
    msg = (d.get("choices") or [{}])[0].get("message") or {}
    reasoning = msg.get("reasoning_content") or ""
    content = msg.get("content") or ""
    print(f"[{label}] {ms}ms | completion={usage.get('completion_tokens')} tok "
          f"| 思考 {len(reasoning)} 字 | 正文 {len(content)} 字 | {round(usage.get('completion_tokens', 0)/(ms/1000), 1)} tok/s")

db.close()

# -*- coding: utf-8 -*-
"""探测提供方对推理控制参数的支持（reasoning_effort / temperature）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_reasoning_params.py
"""

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
base_body = {
    "model": settings.llm_model,
    "messages": [{"role": "user", "content": "用一句话说明毛利率是什么。"}],
    "max_tokens": 200,
}

cases = {
    "默认": {},
    "reasoning_effort=low": {"reasoning_effort": "low"},
    "reasoning_effort=high": {"reasoning_effort": "high"},
    "temperature=0.3": {"temperature": 0.3},
    "thinking=disabled": {"thinking": {"type": "disabled"}},
}

with httpx.Client(timeout=120) as c:
    for name, extra in cases.items():
        body = {**base_body, **extra}
        t0 = time.perf_counter()
        try:
            r = c.post(url, json=body, headers=headers)
            ms = int((time.perf_counter() - t0) * 1000)
            if r.status_code == 200:
                d = r.json()
                usage = d.get("usage") or {}
                msg = (d.get("choices") or [{}])[0].get("message") or {}
                reasoning = msg.get("reasoning_content") or ""
                print(f"[{name}] OK {ms}ms completion={usage.get('completion_tokens')} "
                      f"reasoning_chars={len(reasoning)}")
            else:
                print(f"[{name}] FAIL {r.status_code} {r.text[:200]}")
        except Exception as exc:  # noqa: BLE001
            print(f"[{name}] ERROR {type(exc).__name__}: {exc}")

db.close()

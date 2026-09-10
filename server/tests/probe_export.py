# -*- coding: utf-8 -*-
"""复现/验证会话导出：export_markdown / export_json / usage_stats。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_export.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from app.agent.session import Session, SessionStore, store
from app.db.database import SessionLocal, init_db

init_db()
db = SessionLocal()

row = db.query(__import__("app.db.models", fromlist=["ChatSession"]).ChatSession).first()
if row is None:
    print("no session in db")
    raise SystemExit(0)

print("session:", row.id, row.title)
try:
    md = store.export_markdown(db, row.id)
    print("export_markdown OK, chars:", len(md))
    print(md.splitlines()[0] if md else "")
except Exception as exc:  # noqa: BLE001
    import traceback

    traceback.print_exc()
    print("export_markdown FAIL:", type(exc).__name__, exc)

try:
    js = store.export_json(db, row.id)
    print("export_json OK, keys:", list(js.keys()))
    print("usage:", js.get("usage"))
except Exception as exc:  # noqa: BLE001
    import traceback

    traceback.print_exc()
    print("export_json FAIL:", type(exc).__name__, exc)

# 直接验证 usage_stats 的静态方法语义
s = store.get(db, row.id)
print("usage_stats type:", type(store.usage_stats), "->", store.usage_stats(s))
print("instance call:", store.usage_stats(s)["llm_calls"])

db.close()

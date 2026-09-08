# -*- coding: utf-8 -*-
"""轻量迁移：为 enterprise 表补充 stock_code 列（原型期无 Alembic）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\migrate_stock_code.py
"""

import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "platform.db"

con = sqlite3.connect(DB)
cols = [r[1] for r in con.execute("PRAGMA table_info(enterprise)")]
if "stock_code" not in cols:
    con.execute("ALTER TABLE enterprise ADD COLUMN stock_code VARCHAR(10) DEFAULT ''")
    con.commit()
    print("[migrate] 已添加 enterprise.stock_code")
else:
    print("[migrate] enterprise.stock_code 已存在")

if "data_status_json" not in cols:
    con.execute("ALTER TABLE enterprise ADD COLUMN data_status_json TEXT DEFAULT '{}'")
    con.commit()
    print("[migrate] 已添加 enterprise.data_status_json")
else:
    print("[migrate] enterprise.data_status_json 已存在")

# 回填已有企业的数据状态（有记录=ok，无记录=empty，完全无数据=never）
import json  # noqa: E402

rows = con.execute("SELECT id, name FROM enterprise").fetchall()
for eid, name in rows:
    has = {}
    for dim, table in (("finance", "finance"), ("legal", "legal_record"), ("news", "news")):
        cnt = con.execute(f"SELECT COUNT(*) FROM {table} WHERE enterprise_id=?", (eid,)).fetchone()[0]
        has[dim] = "ok" if cnt else "empty"
    if all(v == "empty" for v in has.values()):
        has = {"finance": "never", "legal": "never", "news": "never"}
    con.execute("UPDATE enterprise SET data_status_json=? WHERE id=?", (json.dumps(has, ensure_ascii=False), eid))
con.commit()
print(f"[migrate] 已回填 {len(rows)} 家企业的数据状态")

# chat_session 用量/压缩字段
ccols = [r[1] for r in con.execute("PRAGMA table_info(chat_session)")]
new_cols = [
    ("summary", "TEXT DEFAULT ''"),
    ("compacted_until", "INTEGER DEFAULT 0"),
    ("compact_count", "INTEGER DEFAULT 0"),
    ("prompt_tokens", "INTEGER DEFAULT 0"),
    ("completion_tokens", "INTEGER DEFAULT 0"),
    ("cache_hit_tokens", "INTEGER DEFAULT 0"),
    ("cache_miss_tokens", "INTEGER DEFAULT 0"),
    ("llm_calls", "INTEGER DEFAULT 0"),
    ("est_cost", "REAL DEFAULT 0"),
    ("pinned", "BOOLEAN DEFAULT 0"),
    ("share_token", "VARCHAR(32) DEFAULT ''"),
    ("share_created_at", "DATETIME"),
]
for name, decl in new_cols:
    if name not in ccols:
        con.execute(f"ALTER TABLE chat_session ADD COLUMN {name} {decl}")
        print(f"[migrate] 已添加 chat_session.{name}")
con.commit()
con.close()
print("[migrate] 完成（新表 mcp_server / skill 由 init_db 自动创建）")

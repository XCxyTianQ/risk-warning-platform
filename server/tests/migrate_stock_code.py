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
con.close()

# -*- coding: utf-8 -*-
"""批量刷新所有有股票代码的企业财务数据（东财摘要 + 新浪三表合并）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\refresh_all_finance.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.datasources.registry import refresh_enterprise
from app.db.database import SessionLocal, init_db
from app.db.models import Enterprise


def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        ents = db.query(Enterprise).filter(Enterprise.stock_code != "").order_by(Enterprise.id).all()
        print(f"targets: {len(ents)}")
        for e in ents:
            try:
                r = refresh_enterprise(db, e.id, ["finance"])
                dim = r.get("dimensions", {}).get("finance", {})
                print(f"  {e.name} ({e.stock_code}): ok={dim.get('ok')} fetched={dim.get('fetched')} "
                      f"ins={dim.get('inserted')} upd={dim.get('updated')} err={dim.get('error') or dim.get('gap') or ''}")
            except Exception as exc:  # noqa: BLE001
                print(f"  {e.name}: FAIL {type(exc).__name__}: {exc}")
    finally:
        db.close()


if __name__ == "__main__":
    main()

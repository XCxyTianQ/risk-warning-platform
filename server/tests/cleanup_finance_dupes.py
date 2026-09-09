# -*- coding: utf-8 -*-
"""清理 finance 表重复行：同 (enterprise_id, year, report_type) 只保留一行。

背景：多信源合并时若未 flush，同一期会插入两行（一行含东财指标、一行含新浪科目）。
本脚本按 metrics_json 键数量择优保留，并合并其余行的指标与顶层字段。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\cleanup_finance_dupes.py
"""

import json
import pathlib
import sys
from collections import defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.db.database import SessionLocal, init_db
from app.db.models import Finance


def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        rows = db.query(Finance).order_by(Finance.id).all()
        groups: dict[tuple, list[Finance]] = defaultdict(list)
        for r in rows:
            groups[(r.enterprise_id, r.year, r.report_type)].append(r)

        removed = merged = 0
        for key, items in groups.items():
            if len(items) < 2:
                continue
            # 保留 metrics 最丰富的行，合并其余
            items.sort(key=lambda r: len(json.loads(r.metrics_json or "{}")), reverse=True)
            keep, rest = items[0], items[1:]
            metrics = json.loads(keep.metrics_json or "{}")
            for r in rest:
                metrics.update(json.loads(r.metrics_json or "{}"))
                for field in ("total_assets", "total_liabilities", "revenue", "net_profit", "debt_ratio"):
                    cur_v = getattr(keep, field) or 0
                    new_v = getattr(r, field) or 0
                    if not cur_v and new_v:
                        setattr(keep, field, new_v)
                if r.source and r.source not in (keep.source or ""):
                    keep.source = (f"{keep.source}+{r.source}" if keep.source else r.source)[:200]
                db.delete(r)
                removed += 1
            keep.metrics_json = json.dumps(metrics, ensure_ascii=False)
            merged += 1
            print(f"  {key}: 保留 id={keep.id}（{len(metrics)} 项指标），删除 {len(rest)} 行")
        db.commit()
        print(f"done: 合并 {merged} 组，删除 {removed} 行")
    finally:
        db.close()


if __name__ == "__main__":
    main()

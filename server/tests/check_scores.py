# -*- coding: utf-8 -*-
"""六维评分快照：打印各企业综合评分与维度分数（规则引擎，不调用大模型）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\check_scores.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.database import SessionLocal
from app.db.models import Enterprise
from app.services.rules import DIM_META, rules_verdict

db = SessionLocal()
print(f"{'企业':24s} {'评分':>6s} {'等级':>5s}  六维分数")
print("-" * 110)
for ent in db.query(Enterprise).order_by(Enterprise.id):
    v = rules_verdict(db, ent.id)
    dims = " ".join(
        f"{DIM_META[k][:2]}={v['dimensions'][k]['score'] if v['dimensions'][k]['score'] is not None else '—'}"
        for k in DIM_META
    )
    print(f"{ent.name[:22]:24s} {str(v['score']):>6s} {v['grade']:>5s}  {dims}")
db.close()

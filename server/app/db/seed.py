"""样例数据入库（阶段2：1 家企业 3 类数据）。幂等：清空重灌。

数据文件：data/samples/*.json（演示数据集 v1，信源=公开报道，企业=杭州深度求索人工智能基础技术研究有限公司）
"""

import json
import os
from pathlib import Path

from app.db.database import SessionLocal, init_db
from app.db.models import Enterprise, Finance, LegalRecord, News

SAMPLES_DIR = Path(__file__).resolve().parents[3] / "data" / "samples"


def _load(name: str):
    with open(SAMPLES_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def seed() -> None:
    init_db()
    ent = _load("enterprise.json")
    legal = _load("legal_records.json")
    news = _load("news.json")
    finance = _load("finance.json")

    db = SessionLocal()
    try:
        # 幂等：清空该企业相关数据重灌
        existing = db.query(Enterprise).filter(Enterprise.name == ent["name"]).first()
        if existing:
            db.query(LegalRecord).filter(LegalRecord.enterprise_id == existing.id).delete()
            db.query(News).filter(News.enterprise_id == existing.id).delete()
            db.query(Finance).filter(Finance.enterprise_id == existing.id).delete()
            db.query(Enterprise).filter(Enterprise.id == existing.id).delete()
            db.commit()

        obj = Enterprise(**{k: v for k, v in ent.items() if k != "facts"})
        db.add(obj)
        db.flush()

        for r in legal:
            db.add(LegalRecord(enterprise_id=obj.id, **r))
        for n in news:
            db.add(News(enterprise_id=obj.id, **n))
        for fd in finance:
            db.add(Finance(enterprise_id=obj.id, **fd))
        db.commit()
        print(f"[seed] ok: {obj.name}（legal={len(legal)}, news={len(news)}, finance={len(finance)}）")
    finally:
        db.close()


if __name__ == "__main__":
    seed()

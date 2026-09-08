"""样例数据入库（多企业演示数据集 v2）。幂等：清空重灌。

数据文件：data/samples/dataset.json（公开信源整理/演示数据）
"""

import json
from pathlib import Path

from app.db.database import SessionLocal, init_db
from app.db.models import Enterprise, Finance, LegalRecord, News, RiskFact

SAMPLES_DIR = Path(__file__).resolve().parents[3] / "data" / "samples"
ENTERPRISE_FIELDS = (
    "name", "unified_code", "stock_code", "legal_rep", "reg_capital_wan",
    "reg_date", "industry", "address", "data_note",
)


def _load(name: str):
    with open(SAMPLES_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def seed() -> None:
    init_db()
    data = _load("dataset.json")

    db = SessionLocal()
    try:
        # 幂等：清空重灌（原型期策略；正式版走迁移+增量）
        db.query(RiskFact).delete()
        db.query(Finance).delete()
        db.query(News).delete()
        db.query(LegalRecord).delete()
        db.query(Enterprise).delete()
        db.commit()

        summary = []
        for item in data["enterprises"]:
            obj = Enterprise(**{k: item[k] for k in ENTERPRISE_FIELDS if k in item})
            db.add(obj)
            db.flush()
            legal = item.get("legal_records", [])
            news = item.get("news", [])
            finance = item.get("finance", [])
            for r in legal:
                db.add(LegalRecord(enterprise_id=obj.id, **r))
            for n in news:
                db.add(News(enterprise_id=obj.id, **n))
            for f in finance:
                db.add(Finance(enterprise_id=obj.id, **f))
            summary.append(f"{obj.name}(legal={len(legal)}, news={len(news)}, finance={len(finance)})")
        db.commit()
        print(f"[seed] ok: {len(summary)} 家企业")
        for line in summary:
            print("  -", line)
    finally:
        db.close()


if __name__ == "__main__":
    seed()

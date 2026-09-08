"""样例数据入库（多企业演示数据集 v2）。幂等：清空重灌。

数据文件：data/samples/dataset.json（公开信源整理/演示数据）
"""

import json
from pathlib import Path

from app.db.database import SessionLocal, init_db
from app.db.models import Enterprise, Finance, LegalRecord, News, RiskFact

SAMPLES_DIR = Path(__file__).resolve().parents[3] / "data" / "samples"


def _samples_dir() -> Path:
    """样例数据目录：桌面端可通过 RWP_SAMPLES_DIR 指向随包资源。"""
    import os

    custom = os.getenv("RWP_SAMPLES_DIR", "")
    if custom and (Path(custom) / "dataset.json").is_file():
        return Path(custom)
    return SAMPLES_DIR
ENTERPRISE_FIELDS = (
    "name", "unified_code", "stock_code", "legal_rep", "reg_capital_wan",
    "reg_date", "industry", "address", "data_note",
)


def _load(name: str):
    with open(_samples_dir() / name, encoding="utf-8") as f:
        return json.load(f)


def seed_if_empty() -> dict:
    """首次运行（空库）时灌入样例数据，让桌面端开箱即有内容。"""
    from app.db.database import SessionLocal

    db = SessionLocal()
    try:
        from app.db.models import Enterprise

        if db.query(Enterprise).count() > 0:
            return {"seeded": False, "reason": "已有数据"}
    finally:
        db.close()
    try:
        seed()
        return {"seeded": True}
    except FileNotFoundError as exc:
        return {"seeded": False, "reason": f"样例数据缺失: {exc}"}


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
            legal = item.get("legal_records", [])
            news = item.get("news", [])
            finance = item.get("finance", [])
            # 数据状态：有记录=ok；查过但确实没有=empty；非上市无财报=never
            obj.data_status_json = json.dumps({
                "finance": "ok" if finance else "never",
                "legal": "ok" if legal else "empty",
                "news": "ok" if news else "empty",
            }, ensure_ascii=False)
            db.add(obj)
            db.flush()
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

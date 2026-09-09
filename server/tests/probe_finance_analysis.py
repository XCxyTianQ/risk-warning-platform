# -*- coding: utf-8 -*-
"""金融分析模块探针：刷新财务数据 → 输出分析结果到 UTF-8 JSON。

用法：
    .venv\\Scripts\\python.exe tests\\probe_finance_analysis.py 康美药业 --refresh
    .venv\\Scripts\\python.exe tests\\probe_finance_analysis.py 贵州茅台
输出：tests/_finance_analysis.json
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.datasources.registry import refresh_enterprise
from app.db.database import SessionLocal, init_db
from app.db.models import Enterprise, Finance
from app.services import finance as fin


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    refresh = "--refresh" in sys.argv
    name = args[0] if args else "康美药业"

    init_db()
    db = SessionLocal()
    try:
        ent = db.query(Enterprise).filter(Enterprise.name.contains(name)).first()
        if ent is None:
            print("NOT FOUND:", name)
            return
        print(f"enterprise: {ent.id} {ent.name} code={ent.stock_code} industry={ent.industry}")

        if refresh:
            result = refresh_enterprise(db, ent.id, ["finance"])
            print("refresh:", json.dumps(result.get("dimensions", {}), ensure_ascii=False))

        rows = db.query(Finance).filter(Finance.enterprise_id == ent.id).order_by(Finance.year).all()
        for r in rows:
            keys = list(json.loads(r.metrics_json or "{}").keys())
            print(f"  {r.year} revenue={r.revenue} net={r.net_profit} debt={r.debt_ratio} metrics={len(keys)}")

        data = fin.analysis(db, ent.id)
        dst = pathlib.Path(__file__).with_name("_finance_analysis.json")
        dst.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print("analysis saved:", dst, dst.stat().st_size, "bytes")
        print("kpi available:", sum(1 for k in data["kpi"] if k["available"]), "/", len(data["kpi"]))
        print("anomalies:", [(a["code"], a["level"]) for a in data["anomalies"]])
        m = data.get("models", {})
        if m:
            print("altman z:", m["altman"]["z"]["score"], m["altman"]["z"]["verdict"],
                  "| z'':", m["altman"]["z2"]["score"], m["altman"]["z2"]["verdict"])
            print("piotroski:", m["piotroski"]["score"], "/", m["piotroski"]["max_score"])
            print("beneish:", m["beneish"]["score"], m["beneish"]["verdict"], "missing:", m["beneish"]["missing"])
        md = fin.report_markdown(db, ent.id)
        pathlib.Path(__file__).with_name("_finance_report.md").write_text(md, encoding="utf-8")
        print("report chars:", len(md))
    finally:
        db.close()


if __name__ == "__main__":
    main()

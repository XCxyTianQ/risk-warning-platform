# -*- coding: utf-8 -*-
"""金融分析 API 探针：走 HTTP 验证 /api/finance 三个端点。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_finance_api.py
输出：tests/_finance_api.txt（UTF-8）
"""

import json
import pathlib

import httpx

BASE = "http://127.0.0.1:8001"
lines: list[str] = []


def log(*parts) -> None:
    text = " ".join(str(p) for p in parts)
    print(text)
    lines.append(text)


with httpx.Client(base_url=BASE, timeout=60) as c:
    ov = c.get("/api/finance/overview").json()
    log("== overview ==", ov["total"], "家")
    for it in ov["items"]:
        log(f"  {it['name']:<28} {it['industry']:<10} year={it['latest_year']} rev={it['revenue']} roe={it['roe']} debt={it['debt_ratio']}")

    for eid, name in [(5, "康美药业"), (1, "贵州茅台"), (3, "宁德时代")]:
        r = c.get(f"/api/finance/{eid}/analysis?years=5")
        if r.status_code != 200:
            log(f"== {name} FAIL {r.status_code}", r.text[:200])
            continue
        a = r.json()
        log(f"== {name} (id={eid}) ==")
        log("  available:", a["available"], "latest:", a.get("latest_year"), "years:", a["data_quality"]["years"])
        if not a["available"]:
            log("  reason:", a.get("reason"), "status:", a.get("data_status"))
            continue
        kpi = {k["key"]: k for k in a["kpi"]}
        log("  KPI:", ", ".join(f"{k['label']}={k['value']}{k['unit']}(yoy {k['yoy']})" for k in a["kpi"][:8] if k["available"]))
        d = a["dupont"]
        log("  dupont:", [(r["year"], r["roe"], r["net_margin"], r["asset_turnover"], r["equity_multiplier"]) for r in d["rows"]])
        if d.get("attribution"):
            log("  attr:", d["attribution"]["roe_delta"], [(i["label"], i["contrib"]) for i in d["attribution"]["items"]])
        m = a["models"]
        log("  altman z:", m["altman"]["z"]["score"], m["altman"]["z"]["verdict"], "missing:", m["altman"]["z"]["missing"])
        log("  altman z'':", m["altman"]["z2"]["score"], m["altman"]["z2"]["verdict"])
        log("  piotroski:", m["piotroski"]["score"], "/", m["piotroski"]["max_score"], m["piotroski"].get("verdict"), "|", m["piotroski"].get("note"))
        log("  beneish:", m["beneish"]["score"], m["beneish"].get("verdict"), "missing:", m["beneish"]["missing"], "approx:", m["beneish"].get("approx"))
        log("  anomalies:", [(x["code"], x["level"]) for x in a["anomalies"]])
        log("  peers:", a["peers"]["note"] if a.get("peers") else None,
            "self pct:", (a["peers"]["self"]["percentiles"] if a.get("peers") and a["peers"].get("self") else None))
        rp = c.get(f"/api/finance/{eid}/report?years=5")
        log("  report:", rp.status_code, len(rp.text), "chars; 首行:", rp.text.splitlines()[0] if rp.text else "")
        lines.append("---- report sample ----")
        lines.extend(rp.text.splitlines()[:40])

pathlib.Path(__file__).with_name("_finance_api.txt").write_text("\n".join(lines), encoding="utf-8")
print("saved tests/_finance_api.txt")

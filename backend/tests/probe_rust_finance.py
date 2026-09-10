# -*- coding: utf-8 -*-
"""金融分析金标准比对：Rust vs Python（KPI / 杜邦 / Z·F·M / 异常 / 对标）。

用法：python backend/tests/probe_rust_finance.py --rust-port 8238 --py-port 8001
"""

import argparse
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--rust-port", type=int, default=8238)
parser.add_argument("--py-port", type=int, default=8001)
parser.add_argument("--ids", default="5,2,3,9")
args = parser.parse_args()

RUST = f"http://127.0.0.1:{args.rust_port}"
PY = f"http://127.0.0.1:{args.py_port}"
ids = [int(x) for x in args.ids.split(",") if x.strip()]

TOL = 0.02


def close(a, b, tol=TOL) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return abs(float(a) - float(b)) <= max(abs(float(b)) * tol, 0.02)
    except (TypeError, ValueError):
        return a == b


total_checks = 0
diffs: list[str] = []

for eid in ids:
    with httpx.Client(timeout=120) as c:
        try:
            r = c.get(f"{RUST}/api/finance/{eid}/analysis").json()
        except Exception as exc:  # noqa: BLE001
            print(f"#{eid} Rust 获取失败: {exc}")
            continue
        try:
            p = c.get(f"{PY}/api/finance/{eid}/analysis").json()
        except Exception as exc:  # noqa: BLE001
            print(f"#{eid} Python 获取失败: {exc}")
            continue

    name = r.get("enterprise", {}).get("name", str(eid))
    print("=" * 72)
    print(f"#{eid} {name}")
    print("-" * 72)
    if r.get("available") != p.get("available"):
        diffs.append(f"#{eid} available: Rust={r.get('available')} Python={p.get('available')}")
        print("  available 不一致，跳过细项")
        continue

    # KPI
    rk = {k["key"]: k for k in r.get("kpi", [])}
    pk = {k["key"]: k for k in p.get("kpi", [])}
    kpi_diffs = []
    for key in pk:
        total_checks += 1
        a, b = rk.get(key, {}).get("value"), pk[key].get("value")
        if not close(a, b):
            kpi_diffs.append(f"{key}: Rust={a} Python={b}")
        total_checks += 1
        if rk.get(key, {}).get("trend") != pk[key].get("trend"):
            kpi_diffs.append(f"{key}.trend: Rust={rk.get(key, {}).get('trend')} Python={pk[key].get('trend')}")
    print(f"  KPI：{'✅ 一致' if not kpi_diffs else '⚠️ ' + '; '.join(kpi_diffs[:5])}")
    diffs += [f"#{eid} KPI {d}" for d in kpi_diffs]

    # 杜邦
    rr = {x["year"]: x for x in r["dupont"]["rows"]}
    pr = {x["year"]: x for x in p["dupont"]["rows"]}
    dup_diffs = []
    for year in pr:
        for field in ("roe", "net_margin", "asset_turnover", "equity_multiplier"):
            total_checks += 1
            if not close(rr.get(year, {}).get(field), pr[year].get(field)):
                dup_diffs.append(f"{year}.{field}: Rust={rr.get(year, {}).get(field)} Python={pr[year].get(field)}")
    print(f"  杜邦：{'✅ 一致' if not dup_diffs else '⚠️ ' + '; '.join(dup_diffs[:4])}")
    diffs += [f"#{eid} dupont {d}" for d in dup_diffs]

    # 模型
    rm, pm = r["models"], p["models"]
    model_diffs = []
    for pair in (("z", "altman"), ("z2", "altman")):
        field, group = pair
        total_checks += 1
        if not close(rm[group][field]["score"], pm[group][field]["score"], 0.01):
            model_diffs.append(
                f"altman.{field}: Rust={rm[group][field]['score']} Python={pm[group][field]['score']}")
        total_checks += 1
        if rm[group][field]["verdict"] != pm[group][field]["verdict"]:
            model_diffs.append(
                f"altman.{field}.verdict: Rust={rm[group][field]['verdict']} Python={pm[group][field]['verdict']}")
    total_checks += 1
    if rm["piotroski"]["score"] != pm["piotroski"]["score"]:
        model_diffs.append(f"F: Rust={rm['piotroski']['score']}/{rm['piotroski']['max_score']} "
                           f"Python={pm['piotroski']['score']}/{pm['piotroski']['max_score']}")
    total_checks += 1
    if not close(rm["beneish"]["score"], pm["beneish"]["score"], 0.01):
        model_diffs.append(f"M: Rust={rm['beneish']['score']} Python={pm['beneish']['score']}")
    print(f"  模型：Z''={rm['altman']['z2']['score']} F={rm['piotroski']['score']}/{rm['piotroski']['max_score']} "
          f"M={rm['beneish']['score']}　{'✅ 一致' if not model_diffs else '⚠️ ' + '; '.join(model_diffs)}")
    diffs += [f"#{eid} model {d}" for d in model_diffs]

    # 异常
    ra = [a["code"] for a in r.get("anomalies", [])]
    pa = [a["code"] for a in p.get("anomalies", [])]
    total_checks += 1
    if ra != pa:
        diffs.append(f"#{eid} anomalies: Rust={ra} Python={pa}")
    print(f"  异常：Rust={ra} Python={pa}　{'✅' if ra == pa else '⚠️'}")

    # 同业对标（本企业分位）
    rs = (r.get("peers") or {}).get("self") or {}
    ps = (p.get("peers") or {}).get("self") or {}
    if rs and ps:
        pct_diffs = []
        for key, val in (ps.get("percentiles") or {}).items():
            total_checks += 1
            if not close((rs.get("percentiles") or {}).get(key), val, 0.05):
                pct_diffs.append(f"{key}: Rust={(rs.get('percentiles') or {}).get(key)} Python={val}")
        print(f"  对标分位：{'✅ 一致' if not pct_diffs else '⚠️ ' + '; '.join(pct_diffs[:4])}")
        diffs += [f"#{eid} peer {d}" for d in pct_diffs]

print("=" * 72)
print(f"比对项 {total_checks} 个，差异 {len(diffs)} 处")
for d in diffs[:25]:
    print("  ⚠️ " + d)
if not diffs:
    print("✅ 金融分析金标准一致：KPI / 杜邦 / Z·F·M / 异常 / 对标分位 全部与 Python 版一致")

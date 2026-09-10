# -*- coding: utf-8 -*-
"""Rust 数据源验证：真实接口抓取 → 入库 → 与 Python 版抓取结果逐字段比对。

用法：python backend/tests/probe_rust_datasource.py --rust-port 8234 --py-port 8001 --enterprise-id 5
"""

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--rust-port", type=int, default=8234)
parser.add_argument("--py-port", type=int, default=8001)
parser.add_argument("--enterprise-id", type=int, default=5)
parser.add_argument("--golden-db", default=r"E:\IUC\rwp-golden\platform.db")
parser.add_argument("--python-db", default=r"E:\IUC\risk-warning-platform\data\platform.db")
args = parser.parse_args()

RUST = f"http://127.0.0.1:{args.rust_port}"
PY = f"http://127.0.0.1:{args.py_port}"
EID = args.enterprise_id

print("=" * 72)
print("一、代码-名称对照（东财全市场快照）")
print("-" * 72)
with httpx.Client(timeout=120) as c:
    t0 = time.perf_counter()
    r = c.get(f"{RUST}/api/resolve_stock", params={"name": "600518"}).json()
    print(f"  600518 → {r.get('candidates')}（{int((time.perf_counter()-t0)*1000)}ms，含代码表首次加载）")
    r2 = c.get(f"{RUST}/api/resolve_stock", params={"name": "康美药业"}).json()
    print(f"  康美药业 → {r2.get('candidates')}")
    r3 = c.get(f"{RUST}/api/resolve_stock", params={"name": "SH600519"}).json()
    print(f"  SH600519 → {r3.get('candidates')}")

print()
print("=" * 72)
print("二、逐维度刷新（真实网络）")
print("-" * 72)
for dim in ["finance", "news", "legal"]:
    with httpx.Client(timeout=300) as c:
        t0 = time.perf_counter()
        res = c.post(f"{RUST}/api/enterprise/{EID}/refresh", params={"dimensions": dim}).json()
    ms = int((time.perf_counter() - t0) * 1000)
    info = (res.get("dimensions") or {}).get(dim, {})
    print(f"  {dim:<8} {ms:>6}ms ok={info.get('ok')} source={info.get('source')} "
          f"fetched={info.get('fetched')} inserted={info.get('inserted')} updated={info.get('updated')} "
          f"err={info.get('error') or info.get('gap') or ''}")
    if dim == "finance":
        print(f"           data_status={res.get('data_status')} alerts_created={res.get('alerts_created')}")

print()
print("=" * 72)
print("三、与 Python 抓取结果比对（同一企业、同一信源）")
print("-" * 72)
rust_db = sqlite3.connect(args.golden_db)
py_db = sqlite3.connect(args.python_db)
rust_fin = {r[0]: r for r in rust_db.execute(
    "SELECT year, revenue, net_profit, debt_ratio, total_assets, source FROM finance WHERE enterprise_id=?",
    (EID,))}
py_fin = {r[0]: r for r in py_db.execute(
    "SELECT year, revenue, net_profit, debt_ratio, total_assets, source FROM finance WHERE enterprise_id=?",
    (EID,))}
# Rust 侧刷新后 source 会带上「新浪」，Python 侧是「AkShare/新浪」
print(f"  Rust 财务期数：{sorted(rust_fin)}")
print(f"  Python 财务期数：{sorted(py_fin)}")
diffs = []
for year in sorted(set(rust_fin) & set(py_fin), reverse=True)[:3]:
    rf, pf = rust_fin[year], py_fin[year]
    for idx, label in ((1, "revenue"), (2, "net_profit"), (3, "debt_ratio"), (4, "total_assets")):
        rv, pv = rf[idx], pf[idx]
        tol = max(abs(pv) * 0.01, 0.5)
        if abs((rv or 0) - (pv or 0)) > tol:
            diffs.append(f"{year}.{label}: Rust={rv} Python={pv}")
    print(f"  {year}: Rust rev={rf[1]} np={rf[2]} debt={rf[3]} | Python rev={pf[1]} np={pf[2]} debt={pf[3]}")
if diffs:
    print(f"  ⚠️ 差异 {len(diffs)} 处（允许 1% 容差）：")
    for d in diffs[:10]:
        print("     " + d)
else:
    print("  ✅ 财务字段在 1% 容差内一致")

rust_news = rust_db.execute("SELECT COUNT(*) FROM news WHERE enterprise_id=?", (EID,)).fetchone()[0]
py_news = py_db.execute("SELECT COUNT(*) FROM news WHERE enterprise_id=?", (EID,)).fetchone()[0]
rust_legal = rust_db.execute("SELECT COUNT(*) FROM legal_record WHERE enterprise_id=?", (EID,)).fetchone()[0]
py_legal = py_db.execute("SELECT COUNT(*) FROM legal_record WHERE enterprise_id=?", (EID,)).fetchone()[0]
print(f"  新闻条数：Rust={rust_news} Python={py_news} | 司法记录：Rust={rust_legal} Python={py_legal}")

print()
print("=" * 72)
print("四、预警生成与 Python 比对")
print("-" * 72)
with httpx.Client(timeout=120) as c:
    rust_alert = c.post(f"{RUST}/api/alerts/generate", json={}).json()
    py_alert = c.post(f"{PY}/api/alerts/generate", json={}).json()
    rust_sum = c.get(f"{RUST}/api/alerts/summary").json()
    py_sum = c.get(f"{PY}/api/alerts/summary").json()
print(f"  Rust  ：企业 {rust_alert.get('enterprises')} 家，新建 {rust_alert.get('created')}，跳过 {rust_alert.get('skipped')}")
print(f"  Python：企业 {py_alert.get('enterprises')} 家，新建 {py_alert.get('created')}，跳过 {py_alert.get('skipped')}")
print(f"  Rust 统计：{json.dumps(rust_sum, ensure_ascii=False)}")
print(f"  Python 统计：{json.dumps(py_sum, ensure_ascii=False)}")

with httpx.Client(timeout=60) as c:
    alerts = c.get(f"{RUST}/api/alerts", params={"limit": 3}).json()
    if alerts.get("items"):
        a = alerts["items"][0]
        print(f"  示例工单：#{a['id']} [{a['level']}] {a['title'][:40]} 状态={a['status_label']} 维度={a['dimension_label']}")
        report = c.get(f"{RUST}/api/alerts/{a['id']}/report")
        print(f"  报告：HTTP {report.status_code}，{len(report.text)} 字符，首行：{report.text.splitlines()[0] if report.text else '-'}")
        handled = c.post(f"{RUST}/api/alerts/{a['id']}/handle", json={"action": "start", "handler": "验证脚本", "note": "P2 验证"}).json()
        print(f"  处置流转：{handled.get('status')} / {handled.get('status_label')}")

rust_db.close()
py_db.close()

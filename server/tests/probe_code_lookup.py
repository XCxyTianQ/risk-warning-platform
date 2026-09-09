# -*- coding: utf-8 -*-
"""股票代码检索探针：验证"用户直接输入股票代码"在各入口的表现。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_code_lookup.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from app.agent.tools import build_registry
from app.datasources.codes import resolve_code, resolve_code_strict, name_of
from app.db.database import SessionLocal

db = SessionLocal()
reg = build_registry()

print("== Agent 工具 search_enterprise ==")
for kw in ["600518", "康美药业", "SH600519", "600519.SH", "300750", "宁德", "601398"]:
    r = reg.call("search_enterprise", {"keyword": kw}, db)
    names = [e["name"] for e in r.get("enterprises", [])]
    print(f"  {kw!r:<14} count={r.get('count')} {names} hint={r.get('hint', '')[:60]}")

print("== Agent 工具 resolve_stock_code ==")
for kw in ["600518", "康美药业", "贵州茅台", "SH600519"]:
    r = reg.call("resolve_stock_code", {"name": kw}, db)
    cands = [(c["code"], c["name"]) for c in r.get("candidates", [])]
    print(f"  {kw!r:<14} {cands[:3]} resolved_name={r.get('resolved_name')}")

print("== 重复建档校验（不产生新数据）==")
from app.services.enterprise import create_enterprise

for kw in ["600518", "SH600519", "康美药业股份有限公司"]:
    r = create_enterprise(db, kw, auto_fetch=False)
    print(f"  create({kw!r}) -> {r.get('error') or r}")

print("== codes 工具函数 ==")
for q in ["600518", "康美药业", "SH600519", "600519.SH", "300750"]:
    print(f"  resolve_code({q!r})        -> {[c['name'] for c in resolve_code(q)][:3]}")
    print(f"  resolve_code_strict({q!r}) -> {(resolve_code_strict(q) or {}).get('name')}")
print(f"  name_of('600518') -> {name_of('600518')!r}")

print("== HTTP 端点 ==")
import httpx

with httpx.Client(base_url="http://127.0.0.1:8001", timeout=30) as c:
    for q in ["600518", "康美药业"]:
        try:
            r = c.get("/api/resolve_stock", params={"name": q}).json()
            print(f"  /api/resolve_stock?name={q!r} -> {[(x['code'], x['name']) for x in r.get('candidates', [])][:3]}")
        except Exception as exc:  # noqa: BLE001
            print(f"  /api/resolve_stock?name={q!r} -> FAIL {exc}")
    try:
        r = c.get("/api/enterprises", params={"q": "600518"}).json()
        print(f"  /api/enterprises?q=600518 -> {[x['name'] for x in r.get('items', [])][:3]}")
    except Exception as exc:  # noqa: BLE001
        print(f"  /api/enterprises?q=600518 -> FAIL {exc}")

db.close()

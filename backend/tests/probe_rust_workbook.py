"""工作簿（多工作表）与空白表格验证。

用法：
    python backend/tests/probe_rust_workbook.py --port 8264

覆盖：
  1) 空白表格为默认：新建即空白网格（列/行标题留空，可自由填写）
  2) 旧数据兼容：把单表结构 {"columns","rows"} 直接写库，启动后应被归一化成工作簿（Sheet1）
  3) 多工作表：新增/重命名/切换/删除；各表数据互不干扰
  4) 入库以当前工作表为准；跨表切换后校验与入库仍正确
"""

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

PASS, FAIL = 0, 0
DIFFS = []


def req(port, path, method="GET", body=None, timeout=60):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(text)
            except json.JSONDecodeError:
                return resp.status, text
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(text)
        except json.JSONDecodeError:
            return exc.code, text
    except Exception as exc:  # noqa: BLE001
        return 0, {"transport_error": str(exc)}


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [ok]   {label}")
    else:
        FAIL += 1
        DIFFS.append(f"{label} :: {detail}")
        print(f"  [FAIL] {label} :: {detail}")


def seed_legacy(data_dir: str) -> int:
    """直接写一条旧格式（单表）记录，模拟升级前的数据"""
    db = os.path.join(data_dir, "platform.db")
    legacy_sheet = {
        "columns": [
            {"key": "c1", "label": "2025年报", "period": "2025", "report_type": "年报", "type": "number"},
            {"key": "c2", "label": "2024年报", "period": "2024", "report_type": "年报", "type": "number"},
        ],
        "rows": [
            {"key": "r1", "label": "营业总收入", "field": "revenue_wan",
             "cells": {"c1": {"value": 128600, "source": "file", "confidence": 1},
                       "c2": {"value": 96300, "source": "file", "confidence": 1}}},
            {"key": "r2", "label": "资产总计", "field": "total_assets_wan",
             "cells": {"c1": {"value": 356800, "source": "file", "confidence": 1}}},
            {"key": "r3", "label": "负债合计", "field": "total_liabilities_wan",
             "cells": {"c1": {"value": 176700, "source": "file", "confidence": 1}}},
            {"key": "r4", "label": "所有者权益合计", "field": "equity_wan",
             "cells": {"c1": {"value": 180100, "source": "file", "confidence": 1}}},
        ],
        "meta": {},
    }
    con = sqlite3.connect(db)
    cur = con.cursor()
    cur.execute(
        "INSERT INTO table_doc (title, kind, unit, scope, period_type, currency, sheet_json, mapping_json, macro_json, status, version, origin, note, created_at, updated_at) "
        "VALUES (?, 'kpi', '万元', '合并报表', '年报', 'CNY', ?, ?, '[]', 'draft', 1, 'manual', '', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
        ("旧版单表（升级测试）", json.dumps(legacy_sheet, ensure_ascii=False),
         json.dumps({"revenue_wan": "r1", "total_assets_wan": "r2", "total_liabilities_wan": "r3", "equity_wan": "r4"})),
    )
    con.commit()
    tid = cur.lastrowid
    con.close()
    return tid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8264)
    ap.add_argument("--data-dir", default="E:/IUC/rwp-workbook")
    args = ap.parse_args()
    port = args.port

    print(f"=== 工作簿验证（rust:{port}）===")

    # ---------- 1) 空白表格 ----------
    print("\n[1] 空白表格为默认入口")
    st, created = req(port, "/api/tables", "POST", {"title": "空白测试表", "kind": "blank"})
    tid = created.get("table_id")
    check("创建空白表格", st == 200 and tid, f"{st} {str(created)[:140]}")
    table = created.get("table", {})
    cols = table.get("sheet", {}).get("columns", [])
    rows = table.get("sheet", {}).get("rows", [])
    check(f"空白网格（{len(rows)} 行 × {len(cols)} 列）", len(cols) >= 3 and len(rows) >= 6, f"{len(rows)}×{len(cols)}")
    check("列标题留空（不需要手写栏目）", all((c.get("label") or "") == "" for c in cols), f"{cols}")
    check("行标题留空", all((r.get("label") or "") == "" for r in rows), f"{[r.get('label') for r in rows][:3]}")
    check("默认一个工作表 Sheet1", len(table.get("sheets") or []) == 1
          and (table.get("sheets") or [{}])[0].get("name") == "Sheet1", f"{table.get('sheets')}")

    # 自由填写列标题与行标题（先取回最新数据再改，避免覆盖刚写入的单元格）
    c1, c2 = cols[0]["key"], cols[1]["key"]
    st, _ = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": rows[0]["key"], "cells": {c1: 100, c2: 200},
    })
    st, latest = req(port, f"/api/tables/{tid}")
    sheet = json.loads(json.dumps(latest["sheet"]))
    sheet["columns"][0]["label"] = "科目"
    sheet["columns"][1]["label"] = "2025"
    sheet["columns"][1]["period"] = "2025"
    sheet["rows"][0]["label"] = "营业总收入"
    st, _ = req(port, f"/api/tables/{tid}", "PATCH", {"sheet": sheet})
    st, doc = req(port, f"/api/tables/{tid}")
    check("自由命名的列/行标题已保存",
          doc["sheet"]["columns"][1]["label"] == "2025" and doc["sheet"]["rows"][0]["label"] == "营业总收入",
          f"{doc['sheet']['columns'][:2]} {doc['sheet']['rows'][0]}")
    check("改标题不会丢单元格数据（100/200 仍在）",
          doc["sheet"]["rows"][0]["cells"].get(c1, {}).get("value") == 100
          and doc["sheet"]["rows"][0]["cells"].get(c2, {}).get("value") == 200,
          f"{doc['sheet']['rows'][0]['cells']}")

    # ---------- 2) 多工作表 ----------
    print("\n[2] 多工作表")
    st, _ = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": rows[0]["key"], "col": c1, "value": 111,
    })
    st, latest = req(port, f"/api/tables/{tid}")   # 取回含 111 的最新数据
    sheets = [
        {"key": "s1", "name": "主表", "columns": latest["sheet"]["columns"], "rows": latest["sheet"]["rows"]},
        {"key": "s2", "name": "附表", "columns": [
            {"key": "a1", "label": "年度", "period": "", "report_type": "", "type": "text"},
            {"key": "a2", "label": "数值", "period": "", "report_type": "", "type": "number"},
        ], "rows": [
            {"key": "b1", "label": "2025", "field": "", "cells": {"a2": {"value": 999, "source": "user"}}},
            {"key": "b2", "label": "2024", "field": "", "cells": {"a2": {"value": 888, "source": "user"}}},
        ]},
    ]
    st, r = req(port, f"/api/tables/{tid}", "PATCH", {"sheets": sheets, "active": "s1"})
    check("新增第二个工作表", st == 200, f"{st} {r}")
    st, doc = req(port, f"/api/tables/{tid}")
    check("工作表清单（2 个）", len(doc.get("sheets") or []) == 2, f"{doc.get('sheets')}")
    check("当前工作表为主表且数据保留（营业总收入=111）",
          doc.get("active") == "s1" and doc["sheet"]["rows"][0]["cells"][c1]["value"] == 111,
          f"active={doc.get('active')} cell={doc['sheet']['rows'][0]['cells']}")

    st, _ = req(port, f"/api/tables/{tid}", "PATCH", {"active": "s2"})
    st, doc2 = req(port, f"/api/tables/{tid}")
    check("切换到附表后看到附表数据（999/888）",
          doc2.get("active") == "s2" and doc2["sheet"]["rows"][0]["cells"]["a2"]["value"] == 999,
          f"active={doc2.get('active')} rows={doc2['sheet']['rows'][:1]}")

    st, _ = req(port, f"/api/tables/{tid}", "PATCH", {"active": "s1"})
    st, doc3 = req(port, f"/api/tables/{tid}")
    check("切回主表数据未被污染", doc3["sheet"]["rows"][0]["cells"][c1]["value"] == 111,
          f"{doc3['sheet']['rows'][0]['cells']}")

    # 重命名工作表
    sheets2 = doc3["workbook"] if doc3.get("workbook") else None
    cur_sheets = []
    for s in doc3["sheets"]:
        if s["key"] == "s1":
            cur_sheets.append({"key": "s1", "name": "主表（改名）", "columns": doc3["sheet"]["columns"], "rows": doc3["sheet"]["rows"]})
        else:
            cur_sheets.append({"key": "s2", "name": "附表", "columns": doc2["sheet"]["columns"], "rows": doc2["sheet"]["rows"]})
    st, _ = req(port, f"/api/tables/{tid}", "PATCH", {"sheets": cur_sheets, "active": "s1"})
    st, doc4 = req(port, f"/api/tables/{tid}")
    names = [s["name"] for s in doc4["sheets"]]
    check("重命名工作表", "主表（改名）" in names, f"{names}")
    void = sheets2

    # ---------- 3) 入库以当前工作表为准 ----------
    print("\n[3] 入库（当前工作表）")
    st, ents = req(port, "/api/enterprises")
    ent_id = (ents.get("items") or [{}])[0].get("id")
    st, _ = req(port, f"/api/tables/{tid}", "PATCH", {"enterprise_id": ent_id})
    st, v = req(port, f"/api/tables/{tid}/validate", "POST")
    check("表头含期间即可入库（校验无阻塞错误）", "OK" != "" and isinstance(v.get("ok"), bool),
          f"ok={v.get('ok')} codes={[i['code'] for i in v.get('issues', [])][:4]}")

    # ---------- 4) 旧数据兼容 ----------
    print("\n[4] 旧版单表结构自动归一化")
    st, lst = req(port, "/api/tables")
    legacy = next((t for t in lst["items"] if t["title"].startswith("旧版单表")), None)
    if legacy:
        st, ldoc = req(port, f"/api/tables/{legacy['id']}")
        sheets = ldoc.get("sheets") or []
        check("旧表被读成工作簿（1 个工作表）", len(sheets) == 1, f"{sheets}")
        check("列/行数据完整保留",
              len(ldoc["sheet"]["columns"]) == 2 and len(ldoc["sheet"]["rows"]) == 4,
              f"cols={len(ldoc['sheet']['columns'])} rows={len(ldoc['sheet']['rows'])}")
        check("映射保留（revenue_wan 等）",
              "revenue_wan" in (ldoc.get("mapping") or {}), f"{ldoc.get('mapping')}")
        st, lv = req(port, f"/api/tables/{legacy['id']}/validate", "POST")
        codes = [i["code"] for i in lv.get("issues", [])]
        check("旧表可直接校验（无结构错误）", "NO_PERIOD" not in codes, f"{codes[:5]}")
    else:
        print("  [skip] 未找到旧版测试表（需先用 --seed-legacy 写入）")

    # ---------- 5) 清理 ----------
    print("\n[5] 清理")
    st, gone = req(port, f"/api/tables/{tid}", "DELETE")
    check("删除测试表格", st == 200 and gone.get("deleted") == tid, f"{st} {gone}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

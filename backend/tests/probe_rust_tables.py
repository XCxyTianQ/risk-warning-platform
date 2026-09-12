"""表格对象（TableDoc）验证：在线创建 → 在线编辑 → 勾稽校验 → 入库 → 引擎联动。

用法：
    python backend/tests/probe_rust_tables.py --port 8250

覆盖：
  1) 模板与字段字典（前端"新建表格"与映射下拉的数据源）
  2) 在线创建（kpi 模板、两期）+ 在线编辑（单格/按行/区域写入）
  3) 勾稽校验：故意写错 → 命中 BALANCE_MISMATCH / DEBT_RATIO_MISMATCH；改对 → 通过
  4) 入库预览（create/update/conflict）→ 入库 → finance 出现用户提供数据
  5) 引擎联动：/api/finance/{id}/analysis 变为 available，六维评分的 finance 维度可评分
  6) 不覆盖公开信源：对有公开数据的企业入库 → skipped + conflicts
  7) 幂等：重复入库走 update 而非 create
  8) 工具面：/api/mcp tools/list 中包含 6 个表格工具（Agent 可用）
"""

import argparse
import json
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8250)
    ap.add_argument("--enterprise", default="杭州深度求索")
    ap.add_argument("--public-enterprise", default="康美药业")
    args = ap.parse_args()
    port = args.port

    print(f"=== 表格对象验证（rust:{port}）===")

    # ---------- 1) 模板与字段字典 ----------
    print("\n[1] 模板与字段字典")
    st, tpl = req(port, "/api/tables/templates")
    check("HTTP 200", st == 200, f"{st} {str(tpl)[:120]}")
    kinds = [t["kind"] for t in tpl.get("templates", [])]
    check(f"内置模板 4 套（{kinds}）", set(kinds) == {"income", "balance", "cashflow", "kpi"}, f"{kinds}")
    fields = tpl.get("fields", [])
    check(f"字段字典含 {len(fields)} 个引擎字段", len(fields) >= 30, f"{len(fields)}")
    rev = next((f for f in fields if f["key"] == "revenue_wan"), None)
    check("营业总收入字段带别名", rev and "营业总收入" in rev["aliases"] and rev["unit"] == "万元", f"{rev}")

    # ---------- 2) 定位企业 ----------
    print("\n[2] 定位企业")
    st, ents = req(port, f"/api/enterprises?q={urllib.request.quote(args.enterprise)}")
    target = (ents.get("items") or [None])[0] if isinstance(ents, dict) else None
    check(f"找到目标企业「{args.enterprise}」", target is not None, f"{ents}")
    if target is None:
        print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
        return 1
    ent_id = target["id"]
    print(f"  企业 id={ent_id} name={target['name']}")

    # 入库前：该企业应无财务数据（金融模块不可用）
    st, before = req(port, f"/api/finance/{ent_id}/analysis")
    check("入库前金融分析不可用（无财报）", before.get("available") is False, f"{str(before)[:140]}")

    # ---------- 3) 在线创建 ----------
    print("\n[3] 在线创建（kpi 模板 · 两期）")
    st, created = req(
        port,
        "/api/tables",
        "POST",
        {
            "enterprise_id": ent_id,
            "title": "深度求索 2024-2025 关键指标（手工录入）",
            "kind": "kpi",
            "periods": [["2025", "年报"], ["2024", "年报"]],
            "unit": "万元",
            "scope": "合并报表",
        },
    )
    check("创建成功", st == 200 and created.get("table_id"), f"{st} {str(created)[:160]}")
    tid = created.get("table_id")
    table = created.get("table", {})
    rows = table.get("sheet", {}).get("rows", [])
    cols = table.get("sheet", {}).get("columns", [])
    check(f"模板行已生成（{len(rows)} 行）", len(rows) == 10, f"{[r['label'] for r in rows]}")
    check("两期列已生成且带期间", len(cols) == 2 and cols[0]["period"] == "2025", f"{cols}")
    check("科目映射已自动建立",
          "revenue_wan" in table.get("mapping", {}) and "debt_ratio" in table.get("mapping", {}),
          f"{table.get('mapping')}")

    def row_of(field):
        return table["mapping"][field]

    # ---------- 4) 在线编辑 ----------
    print("\n[4] 在线编辑（单格 / 按行 / 区域）")
    # 单格
    st, r1 = req(port, f"/api/tables/{tid}/cells", "POST",
                 {"row": row_of("revenue_wan"), "col": cols[0]["key"], "value": 128600})
    check("单格写入", st == 200 and r1.get("written") == 1, f"{st} {r1}")
    # 按行写 2025
    st, r2 = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": row_of("net_profit_wan"),
        "cells": {cols[0]["key"]: -12300},
    })
    check("按行写入", st == 200 and r2.get("written") == 1, f"{st} {r2}")
    # 区域写：资产/负债 两行 × 两期（从 total_assets 行起）
    st, r3 = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": row_of("total_assets_wan"),
        "col": cols[0]["key"],
        "values": [[356800, 301000], [176700, 138460]],
        "source": "user",
    })
    check("区域写入 2×2", st == 200 and r3.get("written") == 4, f"{st} {r3}")
    # 经营现金流两期
    st, _ = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": row_of("ocf_wan"), "col": cols[0]["key"], "values": [[-8200, 4300]],
    })
    # 所有者权益：2025 故意写错（资产 ≠ 负债 + 权益），2024 正确
    st, _ = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": row_of("equity_wan"), "col": cols[0]["key"], "values": [[100000, 162540]],
    })
    st, doc = req(port, f"/api/tables/{tid}")
    cells = {r["key"]: r["cells"] for r in doc["sheet"]["rows"]}
    order = [row_of("total_assets_wan"), row_of("total_liabilities_wan"),
             row_of("ocf_wan"), row_of("equity_wan")]
    got = [[cells[k][cols[i]["key"]]["value"] for i in range(2)] for k in order]
    check("区域写入落到正确行列",
          got == [[356800, 301000], [176700, 138460], [-8200, 4300], [100000, 162540]], f"{got}")

    # ---------- 5) 勾稽校验 ----------
    print("\n[5] 勾稽校验（错误拦截 → 修正通过）")
    st, v1 = req(port, f"/api/tables/{tid}/validate", "POST")
    codes1 = [i["code"] for i in v1.get("issues", [])]
    check("资产不平被拦截（BALANCE_MISMATCH）", "BALANCE_MISMATCH" in codes1, f"{codes1}")
    check("校验不通过时 ok=false", v1.get("ok") is False, f"{v1.get('ok')}")
    st, blocked = req(port, f"/api/tables/{tid}/ingest", "POST", {})
    check("校验不通过 → 入库被阻止", st == 400 and "勾稽校验未通过" in str(blocked), f"{st} {str(blocked)[:140]}")

    # 修正权益使 资产 = 负债 + 权益（2025: 356800 = 176700 + 180100）
    eq_row = row_of("equity_wan")
    st, _ = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": eq_row, "col": cols[0]["key"], "value": 180100,
    })
    check("修正所有者权益", st == 200, f"{st}")
    # 补资产负债率（与 负债/资产 一致：49.52% / 46.00%）
    dr_row = row_of("debt_ratio")
    st, _ = req(port, f"/api/tables/{tid}/cells", "POST", {
        "row": dr_row, "col": cols[0]["key"], "values": [[49.52, 46.0]],
    })
    st, v2 = req(port, f"/api/tables/{tid}/validate", "POST")
    codes2 = [i["code"] for i in v2.get("issues", [])]
    check("修正后勾稽通过", v2.get("ok") is True and "BALANCE_MISMATCH" not in codes2, f"{codes2}")
    check("仍有提示项（缺毛利/净利率等为 info/warn）", v2.get("warnings") is not None, f"{v2}")

    # ---------- 6) 入库预览与入库 ----------
    print("\n[6] 入库预览 → 入库")
    st, pv = req(port, f"/api/tables/{tid}/preview")
    actions = [p["action"] for p in pv.get("plan", [])]
    check("预览显示将新增两期", actions == ["create", "create"], f"{pv.get('plan')}")
    st, done = req(port, f"/api/tables/{tid}/ingest", "POST", {})
    check("入库成功", st == 200 and done.get("ok") is True, f"{st} {str(done)[:200]}")
    check("新增 2 期", len(done.get("created", [])) == 2, f"{done.get('created')}")
    check("来源标记为用户提供", "用户提供" in str(done.get("source")), f"{done.get('source')}")

    # ---------- 7) 引擎联动 ----------
    print("\n[7] 引擎联动（评分 + 金融分析）")
    st, after = req(port, f"/api/finance/{ent_id}/analysis")
    check("金融分析变为可用", after.get("available") is True, f"{str(after)[:160]}")
    kpi = {k["key"]: k for k in after.get("kpi", []) if k.get("available")}
    rev_kpi = kpi.get("revenue", {})
    check("营收 KPI 等于录入值", rev_kpi.get("value") == 128600.0, f"{rev_kpi}")
    check("入库后数据来源标注为用户提供",
          "用户提供" in json.dumps(after.get("data_quality", {}), ensure_ascii=False)
          or any("用户提供" in str(p.get("source", "")) for p in [after.get("data_quality", {})]),
          f"{str(after.get('data_quality'))[:200]}")
    st, dash = req(port, "/api/dashboard/summary")
    row = next((e for e in dash.get("enterprises", []) if e.get("id") == ent_id), None)
    check("六维评分 finance 维度已可评分（manual 数据）",
          row is not None and row.get("dimensions", {}).get("finance") is not None,
          f"{row}")
    st, risk = req(port, f"/api/risk-facts?enterprise_id={ent_id}&limit=5")
    check("风险事实接口正常（入库触发闭环）", st == 200, f"{st}")

    # ---------- 8) 幂等：再次入库走 update ----------
    print("\n[8] 幂等（再次入库 → update）")
    st, again = req(port, f"/api/tables/{tid}/ingest", "POST", {})
    check("第二次入库为更新", st == 200 and len(again.get("updated", [])) == 2 and not again.get("created"),
          f"{str(again)[:200]}")

    # ---------- 9) 不覆盖公开信源 ----------
    print("\n[9] 不覆盖公开信源数据（冲突报告）")
    st, pub = req(port, f"/api/enterprises?q={urllib.request.quote(args.public_enterprise)}")
    pub_ent = (pub.get("items") or [None])[0] if isinstance(pub, dict) else None
    check(f"找到公开数据企业「{args.public_enterprise}」", pub_ent is not None, f"{pub}")
    if pub_ent:
        st, t2 = req(port, "/api/tables", "POST", {
            "enterprise_id": pub_ent["id"], "title": "冲突测试表", "kind": "kpi",
            "periods": ["2025"], "unit": "万元",
        })
        tid2 = t2.get("table_id")
        t2doc = t2.get("table", {})
        m2 = t2doc.get("mapping", {})
        c2 = t2doc["sheet"]["columns"][0]["key"]
        req(port, f"/api/tables/{tid2}/cells", "POST", {
            "row": m2["revenue_wan"], "col": c2, "value": 999999,
        })
        req(port, f"/api/tables/{tid2}/cells", "POST", {
            "row": m2["net_profit_wan"], "col": c2, "value": 888888,
        })
        req(port, f"/api/tables/{tid2}/cells", "POST", {
            "row": m2["total_liabilities_wan"], "col": c2, "value": 100,
        })
        req(port, f"/api/tables/{tid2}/cells", "POST", {
            "row": m2["equity_wan"], "col": c2, "value": 900,
        })
        req(port, f"/api/tables/{tid2}/cells", "POST", {
            "row": m2["total_assets_wan"], "col": c2, "value": 1000,
        })
        st, conflict = req(port, f"/api/tables/{tid2}/ingest", "POST", {})
        check("公开数据未被覆盖（skipped + conflicts）",
              len(conflict.get("skipped", [])) == 1 and len(conflict.get("conflicts", [])) == 1,
              f"{str(conflict)[:240]}")
        diff = (conflict.get("conflicts") or [{}])[0].get("diff", [])
        check("冲突里给出与公开数据的差异", len(diff) > 0, f"{diff}")
        # 清理冲突测试表
        req(port, f"/api/tables/{tid2}", "DELETE")

    # ---------- 10) 工具面 ----------
    print("\n[10] Agent 工具面（模型可用的表格工具）")
    st, tools = req(port, "/api/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
    need = {"list_tables", "get_table", "create_table", "write_table_cells", "validate_table", "ingest_table"}
    check(f"表格工具已注册（共 {len(names)} 个工具）", need <= set(names), f"缺少 {sorted(need - set(names))}")

    # ---------- 11) 清理 ----------
    print("\n[11] 表格列表与删除")
    st, lst = req(port, f"/api/tables?enterprise_id={ent_id}")
    check("按企业筛选列表", st == 200 and lst.get("total", 0) >= 1, f"{str(lst)[:160]}")
    st, gone = req(port, f"/api/tables/{tid}", "DELETE")
    check("删除表格", st == 200 and gone.get("deleted") == tid, f"{st} {gone}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

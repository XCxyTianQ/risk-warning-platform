"""表格「确定性读取」验证：CSV / XLSX / 粘贴 TSV → 新建表格 → 勾稽 → 入库。

与视觉读取的区别：不走模型（零幻觉、零 token），单元格 source=file、confidence=1.0，
因此**无需人工确认**即可入库。

用法：
    python backend/tests/probe_rust_sheets.py --port 8257
"""

import argparse
import base64
import io
import json
import sys
import urllib.error
import urllib.request
import zipfile

PASS, FAIL = 0, 0
DIFFS = []


def req(port, path, method="GET", body=None, timeout=120):
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


def make_xlsx(rows) -> bytes:
    """最小可用 xlsx（inlineStr，无需共享字符串表）"""
    def col(i):
        s = ""
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    sheet = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
    for ri, row in enumerate(rows, start=1):
        sheet.append(f'<row r="{ri}">')
        for ci, v in enumerate(row):
            ref = f"{col(ci)}{ri}"
            if isinstance(v, (int, float)):
                sheet.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                text = str(v).replace("&", "&amp;").replace("<", "&lt;")
                sheet.append(f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>')
        sheet.append("</row>")
    sheet.append("</sheetData></worksheet>")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""")
        z.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""")
        z.writestr("xl/workbook.xml", """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>""")
        z.writestr("xl/_rels/workbook.xml.rels", """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>""")
        z.writestr("xl/worksheets/sheet1.xml", "".join(sheet))
    return buf.getvalue()


WIDE_CSV = """科目,2025年报,2024年报,单位：万元
营业总收入,128600,96300,
营业成本,78900,60100,
归属于母公司股东的净利润,-12300,-5400,
资产总计,356800,301000,
负债合计,176700,138460,
所有者权益合计,180100,162540,
经营活动产生的现金流量净额,-8200,4300,
资产负债率（%）,49.52,46.00,
"""

TSV = "科目\t2025年报\t2024年报\n营业总收入\t128600\t96300\n净利润\t-12300\t-5400\n资产总额\t356800\t301000\n负债合计\t176700\t138460\n所有者权益合计\t180100\t162540\n资产负债率\t49.52\t46.00\n"

LONG_CSV = """年度,科目,数值
2025,营业总收入,128600
2025,归属于母公司股东的净利润,-12300
2025,资产总计,356800
2025,负债合计,176700
2025,所有者权益合计,180100
2024,营业总收入,96300
2024,归属于母公司股东的净利润,-5400
2024,资产总计,301000
2024,负债合计,138460
2024,所有者权益合计,162540
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8257)
    args = ap.parse_args()
    port = args.port
    print(f"=== 表格确定性读取验证（rust:{port}）===")

    st, ents = req(port, "/api/enterprises")
    ent = (ents.get("items") or [{}])[0] if isinstance(ents, dict) else {}
    ent_id = ent.get("id")
    print(f"  绑定企业：{ent.get('name')}（id={ent_id}）")

    # ---------- 1) 粘贴 TSV 直接成表 ----------
    print("\n[1] 粘贴 TSV → 新建表格")
    st, imp = req(port, "/api/tables/import", "POST", {
        "text": TSV, "enterprise_id": ent_id, "title": "TSV 粘贴导入", "unit": "万元",
    })
    check("导入成功", st == 200 and imp.get("table_id"), f"{st} {str(imp)[:200]}")
    check("识别为宽表（列=期间）", imp.get("direction") == "wide", f"{imp.get('direction')}")
    check("解析出两期", len(imp.get("columns") or []) == 2, f"{imp.get('columns')}")
    check("科目映射命中（≥6 项）", (imp.get("mapped_fields") or 0) >= 6, f"{imp.get('mapped_fields')}")
    tid_tsv = imp.get("table_id")
    st, v = req(port, f"/api/tables/{tid_tsv}/validate", "POST")
    codes = [i["code"] for i in v.get("issues", [])]
    check("确定性数据无需人工确认（无 VISION_UNCONFIRMED）", "VISION_UNCONFIRMED" not in codes, f"{codes}")
    check("勾稽通过", v.get("ok") is True, f"{[i['message'] for i in v.get('issues', []) if i['level'] == 'error']}")
    st, ing = req(port, f"/api/tables/{tid_tsv}/ingest", "POST", {})
    check("入库成功（2 期）", st == 200 and len(ing.get("created", [])) == 2, f"{st} {str(ing)[:160]}")
    st, fa = req(port, f"/api/finance/{ent_id}/analysis")
    check("金融分析可用且营收=128600", fa.get("available") is True and
          next((k["value"] for k in fa.get("kpi", []) if k["key"] == "revenue" and k.get("available")), None) == 128600.0,
          f"{str(fa)[:120]}")

    # ---------- 2) 上传 CSV ----------
    print("\n[2] 上传 CSV 文件 → 新建表格")
    st, up = req(port, "/api/attachments", "POST", {
        "filename": "wide.csv", "mime": "text/csv",
        "data_base64": base64.b64encode(WIDE_CSV.encode("utf-8")).decode(),
    })
    aid = (up.get("attachment") or {}).get("id")
    check("CSV 附件上传", st == 200 and aid, f"{st} {str(up)[:140]}")
    st, imp2 = req(port, "/api/tables/import", "POST", {
        "attachment_id": aid, "enterprise_id": ent_id, "title": "CSV 导入（宽表）",
    })
    check("CSV 导入成功", st == 200 and imp2.get("table_id"), f"{st} {str(imp2)[:200]}")
    check("自动识别单位（万元，来自表头「单位：万元」）",
          (imp2.get("detected") or {}).get("unit") == "万元", f"{imp2.get('detected')}")
    check("未映射科目被列出（营业成本等）", isinstance(imp2.get("unmapped"), list), f"{imp2.get('unmapped')}")
    st, doc2 = req(port, f"/api/tables/{imp2['table_id']}")
    cell = None
    for r in doc2["sheet"]["rows"]:
        if "营业总收入" in r["label"]:
            cell = list(r["cells"].values())[0]
    check("单元格标记为确定性来源（source=file / confidence=1.0）",
          cell and cell.get("source") == "file" and cell.get("confidence") == 1.0, f"{cell}")

    # ---------- 3) 上传 XLSX ----------
    print("\n[3] 上传 XLSX 文件 → 新建表格")
    xlsx = make_xlsx([
        ["科目", "2025年报", "2024年报"],
        ["营业总收入", 128600, 96300],
        ["归属于母公司股东的净利润", -12300, -5400],
        ["资产总计", 356800, 301000],
        ["负债合计", 176700, 138460],
        ["所有者权益合计", 180100, 162540],
        ["经营活动产生的现金流量净额", -8200, 4300],
    ])
    st, up2 = req(port, "/api/attachments", "POST", {
        "filename": "report.xlsx",
        "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "data_base64": base64.b64encode(xlsx).decode(),
    })
    aid2 = (up2.get("attachment") or {}).get("id")
    check("XLSX 附件上传", st == 200 and aid2, f"{st} {str(up2)[:140]}")
    st, imp3 = req(port, "/api/tables/import", "POST", {
        "attachment_id": aid2, "enterprise_id": ent_id, "title": "XLSX 导入",
    })
    check("XLSX 导入成功（calamine 解析）", st == 200 and imp3.get("table_id"), f"{st} {str(imp3)[:200]}")
    if imp3.get("table_id"):
        st, doc3 = req(port, f"/api/tables/{imp3['table_id']}")
        vals = {}
        for r in doc3["sheet"]["rows"]:
            cells = list(r["cells"].values())
            vals[r["label"]] = cells[0]["value"] if cells else None
        check("数值抽取正确（营业总收入=128600，净利润=-12300）",
              vals.get("营业总收入") == 128600 and vals.get("归属于母公司股东的净利润") == -12300,
              f"{vals}")

    # ---------- 4) 长表（年度/科目/数值）透视 ----------
    print("\n[4] 长表透视（年度 + 科目 + 数值 → 宽表）")
    st, imp4 = req(port, "/api/tables/import", "POST", {
        "text": LONG_CSV, "enterprise_id": ent_id, "title": "长表透视导入",
    })
    check("识别为长表", st == 200 and imp4.get("direction") == "long", f"{st} {imp4.get('direction')}")
    check("透视出两期两列", len(imp4.get("columns") or []) == 2, f"{imp4.get('columns')}")

    # ---------- 5) 失败路径 ----------
    print("\n[5] 无法识别时的报错")
    st, bad = req(port, "/api/tables/import", "POST", {"text": "随便一段文字\n没有表格结构"})
    check("结构无法识别 → 400 且给出提示", st == 400 and "未能识别" in str(bad), f"{st} {str(bad)[:140]}")
    st, none = req(port, "/api/tables/import", "POST", {})
    check("缺少入参 → 400", st == 400, f"{st} {str(none)[:120]}")

    # ---------- 6) 清理 ----------
    print("\n[6] 清理测试表格")
    removed = 0
    for tid in [tid_tsv, imp2.get("table_id"), imp3.get("table_id"), imp4.get("table_id")]:
        if tid:
            st, _ = req(port, f"/api/tables/{tid}", "DELETE")
            removed += 1 if st == 200 else 0
    check(f"删除导入的表格（{removed} 张）", removed >= 3, f"{removed}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

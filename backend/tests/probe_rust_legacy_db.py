# -*- coding: utf-8 -*-
"""旧数据目录兼容探针：拿一份"升级前"的库（Python 时代 schema）跑 Rust 后端，验证写路径可用。

为什么要这条探针：
    新库由 Rust 自己建（列都带 DEFAULT），旧库是 Python/SQLAlchemy 建的
    （一堆 `NOT NULL` 但没有 DEFAULT）。Rust 侧若用"只插部分列、靠默认值补齐"的写法，
    在旧库上会直接报 NOT NULL 约束失败——而所有用全新临时目录的测试都发现不了。
    所以必须专门拿旧库跑一遍写路径。

用法：
    python backend/tests/probe_rust_legacy_db.py --port 8270 [--data-dir <旧库目录>]

覆盖：会话创建、表格创建/写入/校验、企业建档与删除、预警读取、总览读取。
只走**不需要真实模型**的路径（消息发送需要模型，不在这里测）。
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
        return 0, str(exc)


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
    ap.add_argument("--port", type=int, default=8270)
    ap.add_argument("--data-dir", default="", help="仅用于打印提示：请让后端指向一份旧库")
    args = ap.parse_args()
    port = args.port

    print(f"=== 旧库兼容验证（rust:{port}）===")

    # ---------- 1) 会话（旧库 chat_session 是 NOT NULL 无默认值，最容易踩） ----------
    print("\n[1] 新会话（旧 schema：summary 等列 NOT NULL 且无 DEFAULT）")
    st, created = req(port, "/api/chat/sessions", "POST", {"title": "旧库兼容测试"})
    sid = created.get("session_id") if isinstance(created, dict) else None
    check("创建会话成功", st == 200 and bool(sid), f"{st} {str(created)[:200]}")

    if sid:
        st, detail = req(port, f"/api/chat/sessions/{sid}")
        check("读回会话（summary 等字段有值）", st == 200 and isinstance(detail.get("summary"), str),
              f"{st} summary={detail.get('summary')!r}")
        st, usage = req(port, "/api/chat/usage", body=None)
        check("用量接口可用", st == 200, f"{st} {str(usage)[:120]}")
        st, _ = req(port, f"/api/chat/sessions/{sid}", "DELETE")
        check("删除会话", st == 200, f"{st}")

    # ---------- 2) 表格：创建/写单元格/校验 ----------
    print("\n[2] 表格写路径")
    st, tbl = req(port, "/api/tables", "POST", {"title": "旧库兼容表", "kind": "blank"})
    tid = tbl.get("table_id") if isinstance(tbl, dict) else None
    check("创建空白表格", st == 200 and bool(tid), f"{st} {str(tbl)[:200]}")
    if tid:
        st, _ = req(port, f"/api/tables/{tid}", "PATCH", {"enterprise_id": None, "unit": "万元"})
        check("更新表元数据", st == 200, f"{st}")
        st, v = req(port, f"/api/tables/{tid}/validate", "POST")
        check("校验接口可用", st == 200 and isinstance(v.get("ok"), bool), f"{st} {str(v)[:160]}")
        st, _ = req(port, f"/api/tables/{tid}", "DELETE")
        check("删除表格", st == 200, f"{st}")

    # ---------- 3) 企业：建档（auto_fetch=False 只建档不拉数据）与删除 ----------
    # 说明：/api/enterprises 的设计是"先解析 A 股代码再建档"，非上市企业请走人工导入，
    # 所以这里用已上市企业验证**写入路径**（旧库 enterprise 同样有一批 NOT NULL 无默认值的列）。
    print("\n[3] 企业建档写路径")
    st, ent = req(port, "/api/enterprises", "POST",
                  {"name": "康美药业", "stock_code": "600518", "auto_fetch": False, "industry": "医药制造"})
    eid = ent.get("enterprise_id") if isinstance(ent, dict) else None
    check("创建企业档案（旧库 enterprise 列默认值）", st == 200 and bool(eid), f"{st} {str(ent)[:200]}")
    if eid:
        st, _ = req(port, f"/api/enterprise/{eid}", "DELETE")
        check("删除企业档案", st == 200, f"{st}")

    # ---------- 4) 读路径（旧数据仍在） ----------
    print("\n[4] 旧数据读路径")
    st, ents = req(port, "/api/enterprises")
    n = len(ents.get("items", [])) if isinstance(ents, dict) else 0
    check(f"企业列表可读（{n} 家）", st == 200 and n > 0, f"{st} {str(ents)[:160]}")
    st, alerts = req(port, "/api/alerts")
    check("预警列表可读", st == 200, f"{st} {str(alerts)[:120]}")
    st, summary = req(port, "/api/dashboard/summary")
    check("总览可读", st == 200 and "enterprise_total" in (summary if isinstance(summary, dict) else {}),
          f"{st} {str(summary)[:160]}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

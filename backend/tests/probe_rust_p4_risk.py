"""P4 研判验证：`run_risk_analysis` 工具 + `/api/enterprises/analyze_by_name` + 读侧快照。

用法（需要真实模型配置）：
    python backend/tests/probe_rust_p4_risk.py --rust-port 8240 --py-port 8001 [--with-agent]

比对口径：同一家企业分别由 Rust / Python 发起研判，比较**规则侧**（评分/等级/维度）与
结构字段；LLM 侧结论可能因生成差异不同，只校验字段完整性与交叉校验语义。
`--with-agent` 额外验证对话内工具链：模型调用 run_risk_analysis → 授权 → 结果回注。
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

PASS, FAIL = 0, 0
DIFFS = []


def req(port, path, method="GET", body=None, timeout=180, raw=False):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            if raw:
                return resp.status, text
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


def norm_dims(dims):
    if not isinstance(dims, dict):
        return {}
    return {k: (v or {}).get("score") for k, v in sorted(dims.items())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rust-port", type=int, default=8240)
    ap.add_argument("--py-port", type=int, default=8001)
    ap.add_argument("--name", default="康美药业")
    ap.add_argument("--with-agent", action="store_true")
    args = ap.parse_args()
    rp, pp = args.rust_port, args.py_port
    name = args.name

    print(f"=== P4 研判验证 rust:{rp} python:{pp} 企业={name} ===")

    print("\n[1] analyze_by_name（Rust）")
    rs, rv = req(rp, "/api/enterprises/analyze_by_name", "POST", {"name": name}, timeout=300)
    check("HTTP 200", rs == 200, f"{rs} {str(rv)[:200]}")
    if rs != 200:
        print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
        return 1
    verdict = rv.get("verdict", {})
    ent = rv.get("enterprise", {})
    check("企业定位正确（名称包含关键词即可，与 Python 同为 instr 匹配）",
          name in (ent.get("name") or ""), f"{ent}")
    for key in ("level", "score", "grade", "grade_label", "level_by", "cross_check_ok",
                "llm_level", "rules_level", "dimensions", "summary", "evidence"):
        check(f"verdict 含字段 {key}", key in verdict, f"{list(verdict)}")
    check("六维结论齐全", len(norm_dims(verdict.get("dimensions"))) == 6, f"{norm_dims(verdict.get('dimensions'))}")
    check("最终等级取自规则（level_by=rules 时与 rules_level 一致）",
          verdict.get("level") == verdict.get("rules_level") or verdict.get("level_by") == "llm",
          f"level={verdict.get('level')} rules={verdict.get('rules_level')} by={verdict.get('level_by')}")
    check("evidence 非空且带维度", isinstance(verdict.get("evidence"), list) and len(verdict["evidence"]) > 0,
          f"{str(verdict.get('evidence'))[:160]}")

    print("\n[2] 读侧快照 /api/enterprise/{id}/risk（Rust）")
    eid = ent.get("id")
    rs, snap = req(rp, f"/api/enterprise/{eid}/risk")
    check("HTTP 200", rs == 200, f"{rs}")
    check("快照等级 = 规则等级", snap.get("verdict_level") == verdict.get("rules_level"),
          f"{snap.get('verdict_level')} vs {verdict.get('rules_level')}")
    check("快照含风险事实", isinstance(snap.get("facts"), list) and len(snap["facts"]) > 0,
          f"facts={len(snap.get('facts') or [])}")
    check("事实带来源/时间",
          all(("evidence" in f and "ts" in f) for f in (snap.get("facts") or [])[:5]),
          f"{str((snap.get('facts') or [])[:1])[:160]}")

    print("\n[3] 规则侧与 Python 逐项比对")
    ps, pv = req(pp, "/api/enterprises/analyze_by_name", "POST", {"name": name}, timeout=300)
    check("Python 侧 HTTP 200", ps == 200, f"{ps} {str(pv)[:160]}")
    if ps == 200:
        pverdict = pv.get("verdict", {})
        check("综合评分一致", verdict.get("score") == pverdict.get("score"),
              f"rust={verdict.get('score')} py={pverdict.get('score')}")
        check("评级/等级一致",
              (verdict.get("grade"), verdict.get("rules_level")) == (pverdict.get("grade"), pverdict.get("rules_level")),
              f"rust={(verdict.get('grade'), verdict.get('rules_level'))} py={(pverdict.get('grade'), pverdict.get('rules_level'))}")
        check("六维分数一致", norm_dims(verdict.get("dimensions")) == norm_dims(pverdict.get("dimensions")),
              f"rust={norm_dims(verdict.get('dimensions'))} py={norm_dims(pverdict.get('dimensions'))}")
        check("交叉校验语义一致（level_by 取值域）",
              verdict.get("level_by") in ("rules", "llm") and pverdict.get("level_by") in ("rules", "llm"),
              f"rust={verdict.get('level_by')} py={pverdict.get('level_by')}")

    print("\n[4] /api/risk-facts 已沉淀证据")
    rs, facts = req(rp, f"/api/risk-facts?enterprise_id={eid}&limit=200")
    check("HTTP 200 且条目 >0", rs == 200 and (facts.get("total") or 0) > 0, f"{rs} total={facts.get('total')}")
    dims = {f["dimension"] for f in facts.get("items", [])}
    check("维度标签中文化", all(
        f.get("dimension_label") and f["dimension_label"] != f["dimension"]
        for f in facts.get("items", [])[:5] if f.get("dimension") in
        ("finance", "legal", "news", "operation", "credit", "supply")
    ), f"{sorted(dims)}")

    if args.with_agent:
        print("\n[5] 对话内工具链 run_risk_analysis（含授权）")
        # 授权必须在流未结束时就提交 → 用 http.client 逐行读 SSE
        import http.client

        tool_names, tool_ok, done, errors = [], None, False, []
        approval_seen = False
        conn = http.client.HTTPConnection("127.0.0.1", rp, timeout=600)
        body = json.dumps({"message": f"请对{name}做一次完整的风险研判"}).encode("utf-8")
        conn.request("POST", "/api/chat/stream", body=body,
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        check("SSE 200", resp.status == 200, f"{resp.status}")
        event = None
        if resp.status == 200:
            for raw in resp:
                line = raw.decode("utf-8").rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                try:
                    payload = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if event == "approval" and not approval_seen:
                    approval_seen = True
                    check("写操作触发授权（run_risk_analysis）",
                          payload.get("name") == "run_risk_analysis", f"{payload}")
                    st, appr = req(rp, "/api/chat/approve", "POST",
                                   {"approval_id": payload.get("approval_id"), "approved": True}, timeout=30)
                    check("授权通过", st == 200 and appr.get("approved") is True, f"{st} {appr}")
                elif event == "tool":
                    tool_names.append(payload.get("name"))
                elif event == "tool_result":
                    if payload.get("name") == "run_risk_analysis":
                        tool_ok = payload.get("result")
                elif event == "done":
                    done = True
                elif event == "error":
                    errors.append(payload.get("message"))
        conn.close()
        check("模型调用了 run_risk_analysis", "run_risk_analysis" in tool_names, f"{tool_names}")
        check("研判工具返回 ok", isinstance(tool_ok, dict) and tool_ok.get("ok") is True, f"{tool_ok}")
        if isinstance(tool_ok, dict) and tool_ok.get("ok"):
            # 前端 tool_result 走 summarize()，键集与 Python 版一致
            # （count/score/grade/level/summary/enterprise_* 等），不含 evidence_count
            check("工具结果含评分/等级",
                  tool_ok.get("score") is not None and tool_ok.get("level"),
                  f"{ {k: tool_ok.get(k) for k in ('score', 'level', 'grade', 'enterprise')} }")
            check("UI 摘要键集与 Python 对齐（不含 evidence_count）",
                  "evidence_count" not in tool_ok and "cross_check_ok" not in tool_ok,
                  f"{sorted(tool_ok)}")
        check("对话正常结束（无错误）", done and not errors, f"done={done} errors={errors}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

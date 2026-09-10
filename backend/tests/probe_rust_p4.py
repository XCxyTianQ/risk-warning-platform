"""P4 金标准比对：技能 / 预设 / 插件 / 设置 / MCP / 会话管理（Rust vs Python）。

用法：
    python backend/tests/probe_rust_p4.py --rust-port 8240 --py-port 8001

比对口径：把同一个 SQLite 库分别交给两边，逐端点比对**结构化字段**（忽略时间戳、
自增 id 与生成物顺序差异）。会话导出/导入/分享在 Rust 侧做闭环自检。
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

PASS, FAIL = 0, 0
DIFFS = []


def get(port, path, timeout=30):
    url = f"http://127.0.0.1:{port}{path}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except Exception as exc:  # noqa: BLE001
        return 0, {"transport_error": str(exc)}


def req(port, path, method="GET", body=None, timeout=120):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
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


def norm(value):
    """去掉易变字段，便于结构比对"""
    if isinstance(value, dict):
        return {
            k: norm(v)
            for k, v in sorted(value.items())
            if k not in ("updated_at", "created_at", "exported_at", "synced_at", "last_warm_at",
                         "last_warm_ago", "ts", "elapsed_ms")
        }
    if isinstance(value, list):
        return [norm(v) for v in value]
    return value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rust-port", type=int, default=8240)
    ap.add_argument("--py-port", type=int, default=8001)
    ap.add_argument("--write-port", type=int, default=0,
                    help="会话管理/设置热生效等写侧闭环使用的 Rust 端口；"
                         "默认与 --rust-port 相同，建议指向独立库实例以免污染 parity 比对")
    ap.add_argument("--skip-env-check", action="store_true",
                    help="跳过模型/端点比对（两侧 .env 与进程环境不同源时使用）")
    args = ap.parse_args()
    rp, pp = args.rust_port, args.py_port

    print(f"=== P4 金标准比对 rust:{rp} vs python:{pp} ===")

    # ---------- 技能库 ----------
    print("\n[1] 技能库 /api/skills")
    rs, rv = get(rp, "/api/skills")
    ps, pv = get(pp, "/api/skills")
    check("HTTP 200", rs == 200 and ps == 200, f"rust={rs} py={ps}")
    r_names = [i["name"] for i in rv.get("items", [])] if isinstance(rv, dict) else []
    p_names = [i["name"] for i in pv.get("items", [])] if isinstance(pv, dict) else []
    check(f"内置技能集合一致（{len(p_names)} 条）", r_names == p_names, f"rust={r_names} py={p_names}")
    r_byname = {i["name"]: i for i in rv.get("items", [])}
    p_byname = {i["name"]: i for i in pv.get("items", [])}
    content_ok = all(
        r_byname[n].get("content") == p_byname[n].get("content")
        and r_byname[n].get("description") == p_byname[n].get("description")
        and r_byname[n].get("enabled") == p_byname[n].get("enabled")
        and r_byname[n].get("builtin") == p_byname[n].get("builtin")
        for n in p_names
        if n in r_byname
    )
    check("技能内容/描述/启用/内置标记逐条一致", content_ok)

    # ---------- Agent 预设 ----------
    print("\n[2] Agent 预设 /api/plugins/presets")
    rs, rv = get(rp, "/api/plugins/presets")
    ps, pv = get(pp, "/api/plugins/presets")
    check("HTTP 200", rs == 200 and ps == 200, f"rust={rs} py={ps}")
    r_items = rv.get("items", []) if isinstance(rv, dict) else []
    p_items = pv.get("items", []) if isinstance(pv, dict) else []
    check(f"预设集合一致（{len(p_items)} 条）", norm(r_items) == norm(p_items),
          f"rust={json.dumps(norm(r_items), ensure_ascii=False)[:300]} py={json.dumps(norm(p_items), ensure_ascii=False)[:300]}")

    # ---------- 插件（自定义工具） ----------
    print("\n[3] 手搓插件 /api/plugins/tools")
    rs, rv = get(rp, "/api/plugins/tools")
    ps, pv = get(pp, "/api/plugins/tools")
    check("HTTP 200", rs == 200 and ps == 200, f"rust={rs} py={ps}")
    check("插件集合一致", norm(rv) == norm(pv),
          f"rust={json.dumps(norm(rv), ensure_ascii=False)[:300]} py={json.dumps(norm(pv), ensure_ascii=False)[:300]}")

    # ---------- 设置 ----------
    print("\n[4] 设置 /api/settings")
    rs, rv = get(rp, "/api/settings")
    ps, pv = get(pp, "/api/settings")
    check("HTTP 200", rs == 200 and ps == 200, f"rust={rs} py={ps}")
    r_groups = {g["group"]: {i["key"]: i for i in g["items"]} for g in rv.get("groups", [])}
    p_groups = {g["group"]: {i["key"]: i for i in g["items"]} for g in pv.get("groups", [])}
    check("设置分组一致", sorted(r_groups) == sorted(p_groups), f"rust={sorted(r_groups)} py={sorted(p_groups)}")
    keys_ok, label_ok, type_ok = True, True, True
    for g, items in p_groups.items():
        for k, item in items.items():
            r_item = r_groups.get(g, {}).get(k)
            if r_item is None:
                keys_ok = False
                continue
            label_ok &= r_item.get("label") == item.get("label") and r_item.get("desc") == item.get("desc")
            type_ok &= r_item.get("type") == item.get("type")
    check("字段键集合一致", keys_ok)
    check("字段标签/说明一致", label_ok)
    check("字段类型一致", type_ok)
    check("提供商列表一致", norm(rv.get("providers")) == norm(pv.get("providers")))
    r_rt, p_rt = rv.get("runtime", {}), pv.get("runtime", {})
    if args.skip_env_check:
        print("  [skip] 运行时快照比对（--skip-env-check）")
    else:
        check("运行时快照一致（模型/端点/窗口/审批）",
              all(r_rt.get(k) == p_rt.get(k) for k in ("model", "base_url", "context_window",
                                                       "compaction_enabled", "require_approval", "has_api_key")),
              f"rust={r_rt} py={p_rt}")

    # ---------- MCP ----------
    print("\n[5] MCP 服务 /api/mcp/servers")
    rs, rv = get(rp, "/api/mcp/servers")
    ps, pv = get(pp, "/api/mcp/servers")
    check("HTTP 200", rs == 200 and ps == 200, f"rust={rs} py={ps}")
    check("MCP 服务列表一致", norm(rv) == norm(pv),
          f"rust={json.dumps(norm(rv), ensure_ascii=False)[:200]} py={json.dumps(norm(pv), ensure_ascii=False)[:200]}")

    # ---------- 风险事实 ----------
    print("\n[6] 风险事实 /api/risk-facts")
    rs, rv = get(rp, "/api/risk-facts?limit=200")
    ps, pv = get(pp, "/api/risk-facts?limit=200")
    check("HTTP 200", rs == 200 and ps == 200, f"rust={rs} py={ps}")
    r_texts = sorted(i["text"] for i in rv.get("items", [])) if isinstance(rv, dict) else []
    p_texts = sorted(i["text"] for i in pv.get("items", [])) if isinstance(pv, dict) else []
    check(f"事实条目一致（{len(p_texts)} 条）", r_texts == p_texts,
          f"rust={len(r_texts)} py={len(p_texts)}")
    r_dims = sorted({i["dimension"] for i in rv.get("items", [])}) if isinstance(rv, dict) else []
    p_dims = sorted({i["dimension"] for i in pv.get("items", [])}) if isinstance(pv, dict) else []
    check("事实维度集合一致", r_dims == p_dims, f"rust={r_dims} py={p_dims}")

    # ---------- 会话管理闭环（Rust 侧，写侧：建议指向独立库实例） ----------
    rp = args.write_port or rp
    print(f"\n[7] 会话管理闭环（Rust 侧，写侧，port={rp}）")
    rs, created = req(rp, "/api/chat/sessions", "POST")
    sid = created.get("session_id") if isinstance(created, dict) else None
    check("新建会话", rs == 200 and bool(sid), f"{rs} {created}")
    if sid:
        rs, patched = req(rp, f"/api/chat/sessions/{sid}", "PATCH", {"title": "P4 金标准会话", "pinned": True})
        check("重命名 + 置顶", rs == 200 and patched.get("ok") is True, f"{rs} {patched}")
        rs, listing = get(rp, "/api/chat/sessions?q=P4")
        names = [s["title"] for s in listing.get("sessions", [])] if isinstance(listing, dict) else []
        check("标题检索命中", "P4 金标准会话" in names, f"{names}")
        pinned = [s["pinned"] for s in listing.get("sessions", []) if s["id"] == sid]
        check("置顶标记生效", pinned == [True], f"{pinned}")
        rs, md = get(rp, f"/api/chat/sessions/{sid}/export?format=md")
        check("导出 Markdown", rs == 200 and isinstance(md, str) and md.startswith("# P4 金标准会话"),
              f"{rs} {str(md)[:80]}")
        rs, js = get(rp, f"/api/chat/sessions/{sid}/export?format=json")
        check("导出 JSON kind/version",
              rs == 200 and js.get("kind") == "risk-warning-chat-session" and js.get("version") == 1,
              f"{rs} {str(js)[:120]}")
        rs, shared = req(rp, f"/api/chat/sessions/{sid}/share", "POST")
        token = shared.get("token") if isinstance(shared, dict) else None
        check("生成分享链接", rs == 200 and bool(token), f"{rs} {shared}")
        if token:
            rs, view = get(rp, f"/api/share/{token}")
            check("分享只读视图可访问", rs == 200 and view.get("session_id") == sid, f"{rs} {str(view)[:120]}")
            rs, listing = get(rp, "/api/chat/sessions")
            shared_flags = [s["shared"] for s in listing.get("sessions", []) if s["id"] == sid]
            check("会话列表 shared 标记", shared_flags == [True], f"{shared_flags}")
            rs, revoked = req(rp, f"/api/chat/sessions/{sid}/share", "DELETE")
            check("撤销分享", rs == 200 and revoked.get("ok") is True, f"{rs} {revoked}")
            rs, gone = get(rp, f"/api/share/{token}")
            check("撤销后 404", rs == 404, f"{rs}")
        # 导入闭环：把导出的 JSON 再导入，应生成新会话且消息数一致
        if isinstance(js, dict):
            rs, imported = req(rp, "/api/chat/import", "POST", {"data": js})
            check("导入会话（含重名后缀）",
                  rs == 200 and imported.get("session_id") and "（导入）" in str(imported.get("title")),
                  f"{rs} {imported}")
            rs, bad = req(rp, "/api/chat/import", "POST", {"data": {"kind": "wrong"}})
            check("非法导入被拒（400）", rs == 400, f"{rs} {bad}")
        rs, cleared = req(rp, f"/api/chat/sessions/{sid}/clear", "POST")
        check("清空消息", rs == 200 and cleared.get("deleted_messages") == 0, f"{rs} {cleared}")
        # 用量接口含预热状态
        rs, usage = get(rp, f"/api/chat/usage?session_id={sid}")
        check("用量接口含 preheat 状态",
              rs == 200 and isinstance(usage.get("preheat"), dict) and "enabled" in usage["preheat"],
              f"{rs} {str(usage.get('preheat'))[:120]}")
        rs, deld = req(rp, f"/api/chat/sessions/{sid}", "DELETE")
        check("删除会话", rs == 200, f"{rs} {deld}")

    # ---------- 设置热生效（Rust 侧闭环） ----------
    print("\n[8] 设置热生效（Rust 侧）")
    rs, before = get(rp, "/api/settings")
    old_model = before.get("runtime", {}).get("model")
    rs, applied = req(rp, "/api/settings", "PUT", {"values": {"llm_max_tokens": 1234}})
    check("保存设置返回 applied", rs == 200 and applied.get("applied", {}).get("llm_max_tokens") == 1234,
          f"{rs} {applied}")
    rs, after = get(rp, "/api/settings")
    tok = [i for g in after.get("groups", []) for i in g["items"] if i["key"] == "llm_max_tokens"]
    check("DB 覆盖生效（新值回显）", tok and tok[0]["value"] == 1234, f"{tok}")
    rs, _ = req(rp, "/api/settings", "PUT", {"values": {"llm_max_tokens": 4096}})
    rs, reset = req(rp, "/api/settings/reset", "POST")
    check("重置设置", rs == 200 and reset.get("reset") is True, f"{rs} {reset}")
    check("重置后模型名不变（未覆盖项）",
          get(rp, "/api/settings")[1].get("runtime", {}).get("model") == old_model)

    # ---------- MCP 双向 ----------
    rp = args.rust_port  # 回到只读 parity 实例
    print("\n[9] MCP 双向（服务端暴露 + 客户端接入）")
    r_init = req(rp, "/api/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    p_init = req(pp, "/api/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    r_info = r_init[1].get("result", {}).get("serverInfo", {}) if isinstance(r_init[1], dict) else {}
    p_info = p_init[1].get("result", {}).get("serverInfo", {}) if isinstance(p_init[1], dict) else {}
    r_pv = r_init[1].get("result", {}).get("protocolVersion") if isinstance(r_init[1], dict) else None
    check("服务端 initialize（本平台作为 MCP 服务器）",
          r_info.get("name") == "risk-warning-platform" and r_pv == "2025-06-18",
          f"{r_init[1]}")
    r_tools = req(rp, "/api/mcp", "POST", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    p_tools = req(pp, "/api/mcp", "POST", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    r_names = [t["name"] for t in r_tools[1].get("result", {}).get("tools", [])] if isinstance(r_tools[1], dict) else []
    p_names = [t["name"] for t in p_tools[1].get("result", {}).get("tools", [])] if isinstance(p_tools[1], dict) else []
    check(f"服务端 tools/list 工具集合一致（{len(p_names)} 个）", r_names == sorted(p_names),
          f"rust={r_names} py={sorted(p_names)}")
    r_call = req(rp, "/api/mcp", "POST", {
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "get_platform_overview", "arguments": {}},
    })
    p_call = req(pp, "/api/mcp", "POST", {
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "get_platform_overview", "arguments": {}},
    })
    def call_text(resp):
        try:
            return json.loads(resp[1]["result"]["content"][0]["text"])
        except Exception:  # noqa: BLE001
            return None
    rt_, pt_ = call_text(r_call), call_text(p_call)
    check("服务端 tools/call 结果一致（企业数/均分）",
          rt_ and pt_ and rt_.get("enterprise_total") == pt_.get("enterprise_total")
          and rt_.get("avg_score") == pt_.get("avg_score"),
          f"rust={str(rt_)[:120]} py={str(pt_)[:120]}")
    r_err = req(rp, "/api/mcp", "POST", {"jsonrpc": "2.0", "id": 4, "method": "nope"})
    check("未知方法返回 -32601",
          isinstance(r_err[1], dict) and r_err[1].get("error", {}).get("code") == -32601, f"{r_err[1]}")

    # 客户端：mock MCP 服务（若在跑）
    mcp_probe = get(rp, "/api/mcp/servers")[1]
    mock = next((s for s in mcp_probe.get("items", []) if "8765" in s.get("url", "")), None)
    if mock:
        st, tested = req(rp, f"/api/mcp/servers/{mock['id']}/test", "POST")
        check("MCP 客户端 initialize+tools/list",
              st == 200 and tested.get("ok") is True and len(tested.get("tools", [])) >= 2, f"{st} {tested}")
        st, synced = req(rp, f"/api/mcp/servers/{mock['id']}/sync", "POST")
        check("MCP 工具同步（tool_count>=2）", st == 200 and (synced.get("tool_count") or 0) >= 2, f"{st} {synced}")
    else:
        print("  [skip] 未发现 8765 的 mock MCP 服务（可先启动 tests/mock_mcp_server.py）")

    # ---------- 会话读取 / 导出 / 用量一致性（同一库，两边应逐字节一致） ----------
    print("\n[10] 会话读取/导出/用量一致性（Rust vs Python）")
    shared_db = (not args.write_port) or args.write_port == args.rust_port
    if shared_db:
        print("  [skip] 写侧闭环与 parity 共用同一实例/库，跳过列表与用量比对"
              "（用 --write-port 指向独立库实例即可开启）")
    rs, rl = get(rp, "/api/chat/sessions?limit=50") if not shared_db else (200, {"sessions": []})
    ps, pl = get(pp, "/api/chat/sessions?limit=50")
    r_sess = rl.get("sessions", []) if isinstance(rl, dict) else []
    p_sess = pl.get("sessions", []) if isinstance(pl, dict) else []
    if shared_db:
        print("  [skip] 会话列表条数/字段比对（同上）")
    else:
        check(f"会话列表条数一致（{len(p_sess)}）", len(r_sess) == len(p_sess), f"rust={len(r_sess)} py={len(p_sess)}")
        check("会话列表字段逐项一致", norm(r_sess) == norm(p_sess),
              f"rust={json.dumps(norm(r_sess), ensure_ascii=False)[:200]} py={json.dumps(norm(p_sess), ensure_ascii=False)[:200]}")
    target = next((s["id"] for s in p_sess if s.get("message_count", 0) > 0), None)
    if target is None:
        print("  [skip] 库内暂无含消息的会话（新库场景），跳过导出比对")
    else:
        rs, rd = get(rp, f"/api/chat/sessions/{target}")
        ps, pd = get(pp, f"/api/chat/sessions/{target}")
        check("会话详情 usage 一致",
              rd.get("usage") == pd.get("usage"), f"rust={rd.get('usage')} py={pd.get('usage')}")
        check("会话详情 messages 逐条一致（含 tool_calls 空列表形态）",
              rd.get("messages") == pd.get("messages"),
              f"rust={json.dumps(rd.get('messages'), ensure_ascii=False)[:200]} py={json.dumps(pd.get('messages'), ensure_ascii=False)[:200]}")
        check("会话详情 title/summary 一致",
              (rd.get("title"), rd.get("summary")) == (pd.get("title"), pd.get("summary")),
              f"rust={(rd.get('title'), str(rd.get('summary'))[:40])} py={(pd.get('title'), str(pd.get('summary'))[:40])}")
        rs, rmd = get(rp, f"/api/chat/sessions/{target}/export?format=md")
        ps, pmd = get(pp, f"/api/chat/sessions/{target}/export?format=md")
        check(f"Markdown 导出逐字节一致（{len(pmd) if isinstance(pmd, str) else 0} 字符）",
              isinstance(rmd, str) and rmd == pmd,
              f"rust={str(rmd)[:120]} py={str(pmd)[:120]}")
        rs, rjs = get(rp, f"/api/chat/sessions/{target}/export?format=json")
        ps, pjs = get(pp, f"/api/chat/sessions/{target}/export?format=json")
        check("JSON 导出结构一致（忽略导出时间）", norm(rjs) == norm(pjs),
              f"rust={json.dumps(norm(rjs), ensure_ascii=False)[:200]} py={json.dumps(norm(pjs), ensure_ascii=False)[:200]}")
    rs, ru = get(rp, "/api/chat/usage")
    ps, pu = get(pp, "/api/chat/usage")
    if shared_db:
        print("  [skip] 用量全局统计比对（同上）")
    else:
        check("用量全局统计一致", ru.get("global") == pu.get("global"),
              f"rust={ru.get('global')} py={pu.get('global')}")
    if args.skip_env_check:
        print("  [skip] 用量参数比对（--skip-env-check）")
    else:
        check("用量参数（模型/窗口/压缩比例）一致",
              all(ru.get(k) == pu.get(k) for k in ("model", "context_window", "threshold_ratio", "retain_ratio")),
              f"rust={ {k: ru.get(k) for k in ('model', 'context_window', 'threshold_ratio', 'retain_ratio')} }")
    check("preheat 状态字段齐备",
          isinstance(ru.get("preheat"), dict) and "enabled" in ru["preheat"] and "ttl_seconds" in ru["preheat"],
          f"{str(ru.get('preheat'))[:160]}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    if DIFFS:
        print("差异明细：")
        for d in DIFFS:
            print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

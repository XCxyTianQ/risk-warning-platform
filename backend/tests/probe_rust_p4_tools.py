"""P4 工具装配验证：内置 + 手搓插件 + MCP 工具是否真正进入模型的 tools 数组。

做法：
  1. 在本地起一个"回显型" mock LLM（OpenAI 兼容，支持流式），把收到的 tools 名称
     与 system 前缀原样回显；
  2. 通过 `PUT /api/settings` 把后端指向该 mock（顺带验证设置热生效）；
  3. 发起一轮对话，读取 SSE token 事件，解析回显内容；
  4. 断言：内置工具齐全、插件工具（custom_*）与 MCP 工具（mcp_{id}_{name}）已注册；
     选定预设后白名单过滤生效（含 list_skills/load_skill 恒保留）。

用法：
    python backend/tests/probe_rust_p4_tools.py --port 8240 [--mcp-url http://127.0.0.1:8765/mcp]
"""

import argparse
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PASS, FAIL = 0, 0
DIFFS = []


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [ok]   {label}")
    else:
        FAIL += 1
        DIFFS.append(f"{label} :: {detail}")
        print(f"  [FAIL] {label} :: {detail}")


def req(port, path, method="GET", body=None, timeout=90, raw=False):
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


# ---------------------------------------------------------------------------
# 回显型 mock LLM
# ---------------------------------------------------------------------------

class EchoHandler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        tools = [t.get("function", {}).get("name") for t in (body.get("tools") or [])]
        system = ""
        for m in body.get("messages") or []:
            if m.get("role") == "system":
                system = m.get("content") or ""
                break
        payload = json.dumps(
            {
                "tool_count": len(tools),
                "tools": tools,
                "system_head": system[:80],
                "has_preset": "[当前预设：" in system,
                "model": body.get("model"),
            },
            ensure_ascii=False,
        )
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"choices": [{"delta": {"content": payload}}]},
                {
                    "choices": [{"delta": {}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": 100,
                        "completion_tokens": 20,
                        "prompt_cache_hit_tokens": 80,
                        "prompt_cache_miss_tokens": 20,
                    },
                },
            ]
            for c in chunks:
                self.wfile.write(f"data: {json.dumps(c, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            data = json.dumps(
                {
                    "choices": [{"message": {"role": "assistant", "content": payload}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def start_mock_llm(port):
    server = HTTPServer(("127.0.0.1", port), EchoHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ---------------------------------------------------------------------------

def read_sse_tokens(port, message, preset_id=None):
    """发一轮对话并把 token 事件拼起来"""
    body = {"message": message}
    if preset_id:
        body["preset_id"] = preset_id
    status, text = req(port, "/api/chat/stream", "POST", body, timeout=120, raw=True)
    if status != 200:
        return None, f"HTTP {status}: {str(text)[:200]}"
    out = []
    event = ""
    for line in str(text).splitlines():
        line = line.strip()
        if line.startswith("event:"):
            event = line[6:].strip()
            continue
        if not line.startswith("data:"):
            continue
        try:
            payload = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        if event == "token":
            out.append(payload.get("text", ""))
        elif event == "error":
            return None, f"agent error: {payload}"
    joined = "".join(out)
    try:
        return json.loads(joined), None
    except json.JSONDecodeError:
        return None, f"回显解析失败：{joined[:200]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8240)
    ap.add_argument("--mock-llm-port", type=int, default=9010)
    ap.add_argument("--mcp-url", default="http://127.0.0.1:8765/mcp")
    args = ap.parse_args()
    port = args.port

    print(f"=== P4 工具装配验证（rust:{port}）===")
    start_mock_llm(args.mock_llm_port)

    # 保存原设置
    st, before = req(port, "/api/settings")
    old_rt = before.get("runtime", {}) if isinstance(before, dict) else {}
    old = {"llm_base_url": old_rt.get("base_url"), "llm_model": old_rt.get("model")}

    # 1) 准备一个手搓插件（HTTP 指向 mock LLM 的 /v1/models，仅用于注册）
    st, created = req(
        port,
        "/api/plugins/tools",
        "POST",
        {
            "name": "p4_probe_echo",
            "description": "P4 探针插件（回显）",
            "method": "GET",
            "url": "http://127.0.0.1:%d/v1/models" % args.mock_llm_port,
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        },
    )
    tool_id = created.get("tool_id") if isinstance(created, dict) else None
    check("注册手搓插件", st in (200, 400) and (tool_id or "已存在" in str(created)), f"{st} {created}")
    if tool_id is None:
        st, listing = req(port, "/api/plugins/tools")
        tool_id = next((i["id"] for i in listing.get("items", []) if i["name"] == "p4_probe_echo"), None)
        check("复用已存在的探针插件", tool_id is not None, f"{listing}")

    # 2) 注册/复用 MCP 服务
    st, servers = req(port, "/api/mcp/servers")
    mcp = next((s for s in servers.get("items", []) if s["url"] == args.mcp_url), None)
    if mcp is None:
        st, added = req(port, "/api/mcp/servers", "POST", {"name": "p4-probe-mcp", "url": args.mcp_url})
        check("注册 MCP 服务并同步", st == 200 and added.get("tool_count"), f"{st} {added}")
        mcp_id = added.get("server_id")
    else:
        mcp_id = mcp["id"]
        st, synced = req(port, f"/api/mcp/servers/{mcp_id}/sync", "POST")
        check("MCP 服务同步", st == 200 and synced.get("ok") is True, f"{st} {synced}")
    st, servers = req(port, "/api/mcp/servers")
    mcp = next((s for s in servers.get("items", []) if s["id"] == mcp_id), None)
    mcp_tool_names = [t["name"] for t in (mcp or {}).get("tools", [])]
    check(f"MCP 工具已同步（{mcp_tool_names}）", bool(mcp_tool_names), f"{mcp}")

    # 3) 把后端 LLM 指向回显 mock（设置热生效）
    #    注意：不改 llm_api_key —— 设置会落库（app_setting），而 GET 只回显掩码，
    #    探针无法还原明文；mock 端不校验 key。
    st, applied = req(
        port,
        "/api/settings",
        "PUT",
        {"values": {"llm_base_url": f"http://127.0.0.1:{args.mock_llm_port}/v1",
                    "llm_model": "p4-echo"}},
    )
    check("设置热生效（切到回显 mock）",
          st == 200 and applied.get("applied", {}).get("llm_model") == "p4-echo", f"{st} {applied}")

    try:
        # 4) 默认（无预设）：全部工具
        echoed, err = read_sse_tokens(port, "P4 工具清单探针")
        check("对话拿到工具回显", echoed is not None, err or "")
        if echoed:
            names = set(echoed.get("tools") or [])
            check(f"模型收到 {len(names)} 个工具", len(names) >= 16, f"{sorted(names)}")
            builtin = {"search_enterprise", "get_score_profile", "get_risk_facts", "list_alerts",
                       "get_financial_analysis", "compare_financials", "screen_by_financial_metric",
                       "list_skills", "load_skill", "run_risk_analysis", "get_alert_report",
                       "list_enterprises_by_level", "get_platform_overview", "resolve_stock_code",
                       "add_enterprise", "refresh_enterprise_data", "handle_alert"}
            check("内置工具齐全", builtin <= names, f"缺少 {sorted(builtin - names)}")
            check("手搓插件进入 tools", "custom_p4_probe_echo" in names, f"{sorted(n for n in names if n.startswith('custom_'))}")
            check(f"MCP 工具进入 tools（{mcp_tool_names}）",
                  all(f"mcp_{mcp_id}_{t}" in names for t in mcp_tool_names),
                  f"{sorted(n for n in names if n.startswith('mcp_'))}")
            check("模型名按设置生效", echoed.get("model") == "p4-echo", f"{echoed.get('model')}")
            check("默认 system 无预设段", echoed.get("has_preset") is False, f"{echoed.get('system_head')}")

        # 5) 财务分析师预设（id=4）：工具白名单 + 提示词补充
        echoed2, err2 = read_sse_tokens(port, "P4 预设探针", preset_id=4)
        check("预设对话拿到回显", echoed2 is not None, err2 or "")
        if echoed2:
            names2 = set(echoed2.get("tools") or [])
            expected = {"search_enterprise", "get_financial_analysis", "compare_financials",
                        "screen_by_financial_metric", "get_score_profile", "get_risk_facts",
                        "refresh_enterprise_data", "list_skills", "load_skill"}
            check("预设白名单精确生效", names2 == expected,
                  f"多={sorted(names2 - expected)} 少={sorted(expected - names2)}")
            check("system 注入预设提示词", echoed2.get("has_preset") is True, f"{echoed2.get('system_head')}")
            check("预设过滤掉插件/MCP 工具",
                  not any(n.startswith(("custom_", "mcp_")) for n in names2),
                  f"{sorted(n for n in names2 if n.startswith(('custom_', 'mcp_')))}")
    finally:
        # 还原设置
        if old.get("llm_base_url") and old.get("llm_model"):
            req(port, "/api/settings", "PUT",
                {"values": {"llm_base_url": old["llm_base_url"], "llm_model": old["llm_model"]}})
        if tool_id:
            req(port, f"/api/plugins/tools/{tool_id}", "DELETE")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

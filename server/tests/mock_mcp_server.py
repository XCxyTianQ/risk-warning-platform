# -*- coding: utf-8 -*-
r"""本地 MCP mock 服务（HTTP JSON-RPC 2.0），用于验证外部 MCP 接入。

用法（server 目录）：.venv\Scripts\python.exe tests\mock_mcp_server.py --port 8765
然后在平台「MCP 服务」面板添加：http://127.0.0.1:8765/mcp
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

TOOLS = [
    {
        "name": "echo",
        "description": "回显输入文本（连通性测试）",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
    {
        "name": "company_lookup",
        "description": "示例外部企业查询（返回演示数据）",
        "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
]


def handle_rpc(body: dict) -> dict:
    method = body.get("method")
    params = body.get("params") or {}
    rid = body.get("id", 1)
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "mock-mcp", "version": "0.1.0"},
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "echo":
            text = f"[mock-mcp] echo: {args.get('text', '')}"
        elif name == "company_lookup":
            text = json.dumps({
                "name": args.get("name", ""),
                "source": "mock-mcp",
                "note": "这是外部 MCP 服务返回的演示数据",
                "risk_hint": "示例：外部工商数据接口",
            }, ensure_ascii=False)
        else:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"未知工具: {name}"}}
        return {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}]}}
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"未知方法: {method}"}}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            resp = handle_rpc(body)
        except Exception as exc:  # noqa: BLE001
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}}
        data = json.dumps(resp, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    print(f"[mock-mcp] JSON-RPC MCP server on http://{args.host}:{args.port}/mcp")
    print(f"[mock-mcp] tools: {[t['name'] for t in TOOLS]}")
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

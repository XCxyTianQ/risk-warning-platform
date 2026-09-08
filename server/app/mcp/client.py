"""MCP 客户端（HTTP JSON-RPC 2.0）。

协议要点（与 reasonmc 的 McpServer / mock_server 一致）：
- POST <url>，body = {"jsonrpc":"2.0","id":n,"method":...,"params":{...}}
- 支持 initialize / ping / tools/list / tools/call
- tools/list 返回 {"result": {"tools": [{name, description, inputSchema}]}}
- tools/call 返回 {"result": {"content": [{"type":"text","text":"..."}]}} 或 {"result": {...}}
"""

import json
from dataclasses import dataclass

import httpx


@dataclass
class McpTool:
    name: str
    description: str
    input_schema: dict

    def to_openai_schema(self, prefix: str = "") -> dict:
        return {
            "type": "function",
            "function": {
                "name": f"{prefix}{self.name}",
                "description": self.description or f"MCP tool {self.name}",
                "parameters": self.input_schema or {"type": "object", "properties": {}},
            },
        }


class McpClient:
    def __init__(self, url: str, auth_header: str = "", timeout: float = 30.0):
        self.url = url
        self.auth_header = auth_header
        self._client = httpx.Client(timeout=timeout)

    # ---------- 底层 ----------
    def _rpc(self, method: str, params: dict | None = None, req_id: int = 1) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.auth_header:
            key, _, value = self.auth_header.partition(" ")
            headers[key or "Authorization"] = value or self.auth_header
        payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            payload["params"] = params
        resp = self._client.post(self.url, json=payload, headers=headers)
        if resp.status_code // 100 != 2:
            raise RuntimeError(f"MCP HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(f"MCP error: {data['error']}")
        return data.get("result") or {}

    # ---------- 协议 ----------
    def initialize(self) -> dict:
        return self._rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "clientInfo": {"name": "risk-warning-platform", "version": "0.3"},
            "capabilities": {},
        })

    def ping(self) -> dict:
        return self._rpc("ping", {})

    def list_tools(self) -> list[McpTool]:
        result = self._rpc("tools/list", {})
        tools = []
        for t in result.get("tools") or []:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            tools.append(McpTool(
                name=t["name"],
                description=t.get("description") or "",
                input_schema=t.get("inputSchema") or t.get("input_schema") or {"type": "object", "properties": {}},
            ))
        return tools

    def call_tool(self, name: str, args: dict) -> str:
        result = self._rpc("tools/call", {"name": name, "arguments": args or {}})
        # 标准 content 数组
        content = result.get("content")
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(item.get("text") or "")
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            return "\n".join(parts)
        return json.dumps(result, ensure_ascii=False)

"""MCP 服务管理：注册 / 测试 / 同步工具 / 供 Agent 使用。"""

import json
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.db.models import McpServer
from app.mcp.client import McpClient, McpTool


def list_servers(db: DbSession) -> dict:
    rows = db.query(McpServer).order_by(McpServer.id).all()
    return {"total": len(rows), "items": [
        {
            "id": r.id, "name": r.name, "url": r.url, "enabled": r.enabled,
            "require_approval": r.require_approval, "status": r.status,
            "status_detail": r.status_detail, "tool_count": r.tool_count,
            "tools": json.loads(r.tools_json or "[]"),
            "synced_at": r.synced_at.isoformat() if r.synced_at else None,
        }
        for r in rows
    ]}


def add_server(db: DbSession, name: str, url: str, auth_header: str = "", require_approval: bool = False) -> dict:
    name = (name or "").strip()
    url = (url or "").strip()
    if not name or not url:
        return {"error": "名称与地址不能为空"}
    if db.query(McpServer).filter(McpServer.name == name).first():
        return {"error": f"MCP 服务已存在：{name}"}
    row = McpServer(name=name, url=url, auth_header=auth_header, require_approval=require_approval)
    db.add(row)
    db.commit()
    result = sync_tools(db, row.id)
    return {"server_id": row.id, "name": row.name, **result}


def update_server(db: DbSession, server_id: int, **fields) -> dict:
    row = db.get(McpServer, server_id)
    if row is None:
        return {"error": f"MCP 服务不存在: {server_id}"}
    for k in ("name", "url", "auth_header", "enabled", "require_approval"):
        if k in fields and fields[k] is not None:
            setattr(row, k, fields[k])
    db.commit()
    return {"ok": True, "server_id": row.id}


def delete_server(db: DbSession, server_id: int) -> dict:
    row = db.get(McpServer, server_id)
    if row is None:
        return {"error": f"MCP 服务不存在: {server_id}"}
    name = row.name
    db.delete(row)
    db.commit()
    return {"deleted": server_id, "name": name}


def test_server(db: DbSession, server_id: int) -> dict:
    row = db.get(McpServer, server_id)
    if row is None:
        return {"error": f"MCP 服务不存在: {server_id}"}
    try:
        client = McpClient(row.url, row.auth_header)
        info = client.initialize()
        tools = client.list_tools()
        row.status = "ok"
        row.status_detail = f"初始化成功，发现 {len(tools)} 个工具"
        db.commit()
        return {"ok": True, "server": row.name, "info": info, "tools": [t.name for t in tools]}
    except Exception as exc:  # noqa: BLE001
        row.status = "error"
        row.status_detail = f"{type(exc).__name__}: {exc}"
        db.commit()
        return {"ok": False, "error": row.status_detail}


def sync_tools(db: DbSession, server_id: int) -> dict:
    row = db.get(McpServer, server_id)
    if row is None:
        return {"error": f"MCP 服务不存在: {server_id}"}
    try:
        client = McpClient(row.url, row.auth_header)
        tools = client.list_tools()
    except Exception as exc:  # noqa: BLE001
        row.status = "error"
        row.status_detail = f"{type(exc).__name__}: {exc}"
        db.commit()
        return {"ok": False, "error": row.status_detail}

    row.tools_json = json.dumps([
        {"name": t.name, "description": t.description, "inputSchema": t.input_schema} for t in tools
    ], ensure_ascii=False)
    row.tool_count = len(tools)
    row.status = "ok"
    row.status_detail = f"同步成功：{len(tools)} 个工具"
    row.synced_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "tool_count": len(tools), "tools": [t.name for t in tools]}


def enabled_tools(db: DbSession, prefix: str = "mcp_") -> list[dict]:
    """把启用的 MCP 工具转成 Agent 可注册的形式。

    返回 [{server_id, server_name, require_approval, tool: McpTool, openai_name}]
    """
    out = []
    for row in db.query(McpServer).filter(McpServer.enabled.is_(True)).all():
        try:
            raw = json.loads(row.tools_json or "[]")
        except ValueError:
            raw = []
        for t in raw:
            name = t.get("name")
            if not name:
                continue
            openai_name = f"{prefix}{row.id}_{name}"[:64]
            out.append({
                "server_id": row.id,
                "server_name": row.name,
                "server_url": row.url,
                "auth_header": row.auth_header,
                "require_approval": bool(row.require_approval),
                "tool": McpTool(name=name, description=t.get("description") or "",
                                input_schema=t.get("inputSchema") or {"type": "object", "properties": {}}),
                "openai_name": openai_name,
            })
    return out

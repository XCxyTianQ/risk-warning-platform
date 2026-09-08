"""MCP API：服务管理 + 本平台对外暴露的 MCP 端点。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db.database import get_db
from app.mcp import service as svc

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class ServerIn(BaseModel):
    name: str
    url: str
    auth_header: str = ""
    require_approval: bool = False


class ServerPatch(BaseModel):
    name: str | None = None
    url: str | None = None
    auth_header: str | None = None
    enabled: bool | None = None
    require_approval: bool | None = None


@router.get("/servers")
def list_servers(db: DbSession = Depends(get_db)):
    return svc.list_servers(db)


@router.post("/servers")
def add_server(body: ServerIn, db: DbSession = Depends(get_db)):
    result = svc.add_server(db, body.name, body.url, body.auth_header, body.require_approval)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


@router.patch("/servers/{server_id}")
def update_server(server_id: int, body: ServerPatch, db: DbSession = Depends(get_db)):
    result = svc.update_server(db, server_id, **body.model_dump(exclude_none=True))
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.delete("/servers/{server_id}")
def delete_server(server_id: int, db: DbSession = Depends(get_db)):
    result = svc.delete_server(db, server_id)
    if result.get("error"):
        raise HTTPException(404, result["error"])
    return result


@router.post("/servers/{server_id}/test")
def test_server(server_id: int, db: DbSession = Depends(get_db)):
    return svc.test_server(db, server_id)


@router.post("/servers/{server_id}/sync")
def sync_server(server_id: int, db: DbSession = Depends(get_db)):
    return svc.sync_tools(db, server_id)


# ---------------------------------------------------------------------------
# 本平台对外暴露的 MCP 服务（JSON-RPC 2.0）
# ---------------------------------------------------------------------------

class RpcIn(BaseModel):
    jsonrpc: str = "2.0"
    id: int | str | None = 1
    method: str
    params: dict | None = None


@router.post("")
def mcp_endpoint(body: RpcIn, db: DbSession = Depends(get_db)):
    """让其他 Agent / 客户端把本平台当作 MCP 工具服务器使用。"""
    from app.agent.tools import build_registry

    registry = build_registry()

    def ok(result: dict):
        return {"jsonrpc": "2.0", "id": body.id, "result": result}

    if body.method == "initialize":
        return ok({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "risk-warning-platform", "version": "0.3"},
        })
    if body.method == "ping":
        return ok({})
    if body.method == "tools/list":
        tools = []
        for schema in registry.definitions():
            fn = schema["function"]
            tools.append({
                "name": fn["name"],
                "description": fn["description"],
                "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
            })
        return ok({"tools": tools})
    if body.method == "tools/call":
        params = body.params or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if not name:
            return {"jsonrpc": "2.0", "id": body.id, "error": {"code": -32602, "message": "缺少工具名"}}
        result = registry.call(name, args, db)
        return ok({"content": [{"type": "text", "text": _as_text(result)}]})
    return {"jsonrpc": "2.0", "id": body.id, "error": {"code": -32601, "message": f"未知方法: {body.method}"}}


def _as_text(result) -> str:
    import json

    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False)

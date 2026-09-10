//! MCP 服务管理 API：`/api/mcp/*`。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::services::mcp;
use crate::state::AppState;

/// GET /api/mcp/servers
pub async fn list(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(mcp::list_servers(&st.db)?))
}

#[derive(Deserialize)]
pub struct ServerIn {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub auth_header: String,
    #[serde(default)]
    pub require_approval: bool,
}

/// POST /api/mcp/servers —— 注册并立即同步工具
pub async fn create(
    State(st): State<AppState>,
    Json(body): Json<ServerIn>,
) -> AppResult<Json<Value>> {
    let result =
        mcp::add_server(&st.db, &body.name, &body.url, &body.auth_header, body.require_approval).await?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// PATCH /api/mcp/servers/{id}
pub async fn update(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = mcp::update_server(&st.db, id, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// DELETE /api/mcp/servers/{id}
pub async fn delete(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = mcp::delete_server(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// POST /api/mcp/servers/{id}/test
pub async fn test_server(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = mcp::test_server(&st.db, id).await?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// POST /api/mcp/servers/{id}/sync
pub async fn sync_server(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = mcp::sync_tools(&st.db, id).await?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// POST /api/mcp —— **服务端**：让其他 Agent / 客户端把本平台当作 MCP 工具服务器使用。
///
/// 支持 initialize / ping / tools/list / tools/call（与 Python 版 `app/api/mcp.py` 对齐）。
#[derive(Deserialize)]
pub struct RpcIn {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

fn ok(id: &Option<Value>, result: Value) -> Json<Value> {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id.clone().unwrap_or(json!(1)),
        "result": result,
    }))
}

fn rpc_error(id: &Option<Value>, code: i64, message: String) -> Json<Value> {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id.clone().unwrap_or(json!(1)),
        "error": { "code": code, "message": message },
    }))
}

pub async fn rpc_endpoint(
    State(st): State<AppState>,
    Json(body): Json<RpcIn>,
) -> AppResult<Json<Value>> {
    let registry = crate::agent::tools::build_registry();
    match body.method.as_str() {
        "initialize" => Ok(ok(
            &body.id,
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "risk-warning-platform", "version": env!("CARGO_PKG_VERSION") },
            }),
        )),
        "ping" => Ok(ok(&body.id, json!({}))),
        "tools/list" => {
            let tools: Vec<Value> = registry
                .definitions()
                .iter()
                .filter_map(|schema| {
                    let f = schema.get("function")?;
                    Some(json!({
                        "name": f.get("name")?,
                        "description": f.get("description").cloned().unwrap_or(json!("")),
                        "inputSchema": f
                            .get("parameters")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    }))
                })
                .collect();
            Ok(ok(&body.id, json!({ "tools": tools })))
        }
        "tools/call" => {
            let params = body.params.clone().unwrap_or(json!({}));
            let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
                return Ok(rpc_error(&body.id, -32602, "缺少工具名".into()));
            };
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let result = if crate::agent::tools::is_async_tool(name) {
                crate::agent::tools::call_tool_async(&st, name, &args).await
            } else {
                crate::agent::tools::call_tool(&st.db, name, &args, &[])
            };
            let text = if let Some(s) = result.as_str() {
                s.to_string()
            } else {
                serde_json::to_string(&result).unwrap_or_else(|_| "{}".into())
            };
            Ok(ok(&body.id, json!({ "content": [{ "type": "text", "text": text }] })))
        }
        other => Ok(rpc_error(&body.id, -32601, format!("未知方法: {other}"))),
    }
}

//! MCP 服务管理（HTTP JSON-RPC 2.0）：注册 / 测试 / 同步工具 / 供 Agent 使用。
//!
//! 协议要点（与 Python 版 `app/mcp/client.py` 一致）：
//! - POST <url>，body = {"jsonrpc":"2.0","id":n,"method":...,"params":{...}}
//! - 支持 initialize / ping / tools/list / tools/call
//! - tools/list 返回 {"result": {"tools": [{name, description, inputSchema}]}}
//! - tools/call 返回 {"result": {"content": [{"type":"text","text":"..."}]}} 或 {"result": {...}}

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::db::Db;
use crate::util::now_db;

const UA: &str = "risk-warning-platform/0.5 (+mcp-client)";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(UA)
        .pool_max_idle_per_host(0)
        .build()
        .unwrap_or_default()
}

async fn rpc(url: &str, auth_header: &str, method: &str, rpc_params: Option<Value>) -> Result<Value> {
    let mut payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method });
    if let Some(p) = rpc_params {
        payload["params"] = p;
    }
    let mut req = client()
        .post(url)
        .header("Content-Type", "application/json")
        .json(&payload);
    if !auth_header.is_empty() {
        // "Authorization Bearer xxx" / "X-Api-Key xxx" / 裸 token
        match auth_header.split_once(' ') {
            Some((k, v)) => req = req.header(k, v),
            None => req = req.header("Authorization", auth_header),
        }
    }
    let resp = req.send().await.with_context(|| format!("请求失败：{url}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!(
            "MCP HTTP {}: {}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        );
    }
    let data: Value = serde_json::from_str(&text)
        .with_context(|| format!("MCP 响应不是合法 JSON：{}", text.chars().take(200).collect::<String>()))?;
    if let Some(err) = data.get("error") {
        if !err.is_null() {
            anyhow::bail!("MCP error: {err}");
        }
    }
    Ok(data.get("result").cloned().unwrap_or(json!({})))
}

#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

pub async fn initialize(url: &str, auth: &str) -> Result<Value> {
    rpc(
        url,
        auth,
        "initialize",
        Some(json!({
            "protocolVersion": "2025-06-18",
            "clientInfo": { "name": "risk-warning-platform", "version": "0.5" },
            "capabilities": {},
        })),
    )
    .await
}

pub async fn list_tools(url: &str, auth: &str) -> Result<Vec<McpTool>> {
    let result = rpc(url, auth, "tools/list", Some(json!({}))).await?;
    let mut tools = Vec::new();
    for t in result.get("tools").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let Some(name) = t.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        tools.push(McpTool {
            name: name.to_string(),
            description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            input_schema: t
                .get("inputSchema")
                .or_else(|| t.get("input_schema"))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
        });
    }
    Ok(tools)
}

/// 调用 MCP 工具；标准 content 数组拼成文本，其余原样 JSON
pub async fn call_tool(url: &str, auth: &str, name: &str, args: &Value) -> Value {
    let result = match rpc(url, auth, "tools/call", Some(json!({ "name": name, "arguments": args }))).await {
        Ok(v) => v,
        Err(err) => return json!({ "error": format!("MCP 调用失败: {err}") }),
    };
    let text = match result.get("content").and_then(|v| v.as_array()) {
        Some(items) => items
            .iter()
            .map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()
                } else {
                    serde_json::to_string(item).unwrap_or_default()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        None => serde_json::to_string(&result).unwrap_or_default(),
    };
    json!({ "mcp_result": text })
}

// ---------------------------------------------------------------------------
// 服务管理（DB）
// ---------------------------------------------------------------------------

fn server_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let tools_raw: String = r.get(7)?;
    // 与 Python 版一致：直接回传 tools_json（含 inputSchema），供前端展示与调试
    let tools: Value = serde_json::from_str(&tools_raw).unwrap_or_else(|_| json!([]));
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "name": r.get::<_, String>(1)?,
        "url": r.get::<_, String>(2)?,
        "enabled": r.get::<_, i64>(3)? != 0,
        "require_approval": r.get::<_, i64>(4)? != 0,
        "status": r.get::<_, String>(5)?,
        "status_detail": r.get::<_, String>(6)?,
        "tool_count": r.get::<_, i64>(8)?,
        "tools": tools,
        "synced_at": crate::util::opt_db_to_iso(r.get::<_, Option<String>>(9)?),
    }))
}

const SERVER_COLS: &str = "id, name, url, enabled, require_approval, status, status_detail, tools_json, tool_count, synced_at";

pub fn list_servers(db: &Db) -> Result<Value> {
    let items = db.with(|conn| {
        let mut stmt = conn.prepare(&format!("SELECT {SERVER_COLS} FROM mcp_server ORDER BY id"))?;
        let rows = stmt.query_map([], server_json)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": items.len(), "items": items }))
}

pub fn get_server(db: &Db, server_id: i64) -> Result<Option<(String, String, String, bool)>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT name, url, auth_header, require_approval FROM mcp_server WHERE id = ?1",
                [server_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)? != 0,
                    ))
                },
            )
            .optional()?;
        Ok(row)
    })
}

pub async fn add_server(
    db: &Db,
    name: &str,
    url: &str,
    auth_header: &str,
    require_approval: bool,
) -> Result<Value> {
    let name = name.trim().to_string();
    let url = url.trim().to_string();
    if name.is_empty() || url.is_empty() {
        return Ok(json!({ "error": "名称与地址不能为空" }));
    }
    let dup: Option<i64> = db.with(|conn| {
        Ok(conn
            .query_row("SELECT id FROM mcp_server WHERE name = ?1", [&name], |r| r.get(0))
            .optional()?)
    })?;
    if dup.is_some() {
        return Ok(json!({ "error": format!("MCP 服务已存在：{name}") }));
    }
    let id = db.with(|conn| {
        conn.execute(
            "INSERT INTO mcp_server (name, url, auth_header, enabled, require_approval, status, status_detail, tools_json, tool_count, created_at)
             VALUES (?1, ?2, ?3, 1, ?4, 'unknown', '', '[]', 0, ?5)",
            params![name, url, auth_header, require_approval as i64, now_db()],
        )?;
        Ok(conn.last_insert_rowid())
    })?;
    let sync = sync_tools(db, id).await?;
    let mut out = json!({ "server_id": id, "name": name });
    if let (Some(dst), Some(src)) = (out.as_object_mut(), sync.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    Ok(out)
}

pub fn update_server(db: &Db, server_id: i64, body: &Value) -> Result<Value> {
    let exists: Option<i64> = db.with(|conn| {
        Ok(conn
            .query_row("SELECT id FROM mcp_server WHERE id = ?1", [server_id], |r| r.get(0))
            .optional()?)
    })?;
    if exists.is_none() {
        return Ok(json!({ "error": format!("MCP 服务不存在: {server_id}") }));
    }
    db.with(|conn| {
        for key in ["name", "url", "auth_header"] {
            if let Some(v) = body.get(key).and_then(|v| v.as_str()) {
                conn.execute(
                    &format!("UPDATE mcp_server SET {key} = ?1 WHERE id = ?2"),
                    params![v, server_id],
                )?;
            }
        }
        for key in ["enabled", "require_approval"] {
            if let Some(v) = body.get(key).and_then(|v| v.as_bool()) {
                conn.execute(
                    &format!("UPDATE mcp_server SET {key} = ?1 WHERE id = ?2"),
                    params![v as i64, server_id],
                )?;
            }
        }
        Ok(json!({ "ok": true, "server_id": server_id }))
    })
}

pub fn delete_server(db: &Db, server_id: i64) -> Result<Value> {
    db.with(|conn| {
        let row: Option<String> = conn
            .query_row("SELECT name FROM mcp_server WHERE id = ?1", [server_id], |r| r.get(0))
            .optional()?;
        let Some(name) = row else {
            return Ok(json!({ "error": format!("MCP 服务不存在: {server_id}") }));
        };
        conn.execute("DELETE FROM mcp_server WHERE id = ?1", [server_id])?;
        Ok(json!({ "deleted": server_id, "name": name }))
    })
}

fn set_status(db: &Db, server_id: i64, status: &str, detail: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE mcp_server SET status = ?1, status_detail = ?2 WHERE id = ?3",
            params![status, detail, server_id],
        )?;
        Ok(())
    })
}

pub async fn test_server(db: &Db, server_id: i64) -> Result<Value> {
    let Some((name, url, auth, _)) = get_server(db, server_id)? else {
        return Ok(json!({ "error": format!("MCP 服务不存在: {server_id}") }));
    };
    match initialize(&url, &auth).await {
        Ok(info) => match list_tools(&url, &auth).await {
            Ok(tools) => {
                let detail = format!("初始化成功，发现 {} 个工具", tools.len());
                set_status(db, server_id, "ok", &detail)?;
                Ok(json!({
                    "ok": true,
                    "server": name,
                    "info": info,
                    "tools": tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
                }))
            }
            Err(err) => {
                let detail = err.to_string();
                set_status(db, server_id, "error", &detail)?;
                Ok(json!({ "ok": false, "error": detail }))
            }
        },
        Err(err) => {
            let detail = err.to_string();
            set_status(db, server_id, "error", &detail)?;
            Ok(json!({ "ok": false, "error": detail }))
        }
    }
}

pub async fn sync_tools(db: &Db, server_id: i64) -> Result<Value> {
    let Some((_name, url, auth, _)) = get_server(db, server_id)? else {
        return Ok(json!({ "error": format!("MCP 服务不存在: {server_id}") }));
    };
    let tools = match list_tools(&url, &auth).await {
        Ok(t) => t,
        Err(err) => {
            let detail = err.to_string();
            set_status(db, server_id, "error", &detail)?;
            return Ok(json!({ "ok": false, "error": detail }));
        }
    };
    let payload: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
            })
        })
        .collect();
    let count = tools.len() as i64;
    db.with(|conn| {
        conn.execute(
            "UPDATE mcp_server SET tools_json = ?1, tool_count = ?2, status = 'ok', status_detail = ?3, synced_at = ?4 WHERE id = ?5",
            params![
                serde_json::to_string(&payload).unwrap_or_else(|_| "[]".into()),
                count,
                format!("同步成功：{count} 个工具"),
                now_db(),
                server_id,
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({
        "ok": true,
        "tool_count": count,
        "tools": tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
    }))
}

/// 供 Agent 注册的 MCP 工具项
#[derive(Debug, Clone)]
pub struct EnabledTool {
    pub server_id: i64,
    pub server_name: String,
    pub server_url: String,
    pub auth_header: String,
    pub require_approval: bool,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub openai_name: String,
}

pub fn enabled_tools(db: &Db) -> Result<Vec<EnabledTool>> {
    let rows = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, url, auth_header, require_approval, tools_json FROM mcp_server WHERE enabled = 1 ORDER BY id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)? != 0,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let mut out = Vec::new();
    for (id, server_name, server_url, auth_header, require_approval, tools_raw) in rows {
        let tools: Value = serde_json::from_str(&tools_raw).unwrap_or_else(|_| json!([]));
        for t in tools.as_array().cloned().unwrap_or_default() {
            let Some(name) = t.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let openai_name: String = format!("mcp_{id}_{name}").chars().take(64).collect();
            out.push(EnabledTool {
                server_id: id,
                server_name: server_name.clone(),
                server_url: server_url.clone(),
                auth_header: auth_header.clone(),
                require_approval,
                name: name.to_string(),
                description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                input_schema: t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                openai_name,
            });
        }
    }
    Ok(out)
}

/// 解析 `mcp_{server_id}_{tool}` 形式的工具名（用于分发调用）
pub fn parse_tool_name(db: &Db, openai_name: &str) -> Option<EnabledTool> {
    let rest = openai_name.strip_prefix("mcp_")?;
    let (id_text, tool_name) = rest.split_once('_')?;
    let server_id: i64 = id_text.parse().ok()?;
    enabled_tools(db)
        .ok()?
        .into_iter()
        .find(|t| t.server_id == server_id && t.name == tool_name)
}

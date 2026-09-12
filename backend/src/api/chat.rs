//! 对话接口：SSE 流式对话 + 会话管理 + 用量。

use std::convert::Infallible;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::runner::{context_pressure, run_agent};
use crate::agent::session::SessionStore;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct StreamReq {
    pub message: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub preset_id: Option<i64>,
    /// 本轮携带的附件（图片/表格文件），先经 `/api/attachments` 上传拿到 id
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

/// POST /api/chat/stream —— SSE 流式对话
pub async fn stream(
    State(st): State<AppState>,
    Json(req): Json<StreamReq>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    if req.message.trim().is_empty() && req.attachment_ids.is_empty() {
        return Err(AppError::bad_request("message 与 attachment_ids 不能同时为空"));
    }
    let store = SessionStore::new();
    let session = store.get_or_create(&st.db, req.session_id.as_deref())?;
    let events = run_agent(st.clone(), session, req.message, req.preset_id, req.attachment_ids);
    let sse = events.map(|e| Ok::<_, Infallible>(e.to_sse()));
    Ok(Sse::new(sse).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub q: String,
}

fn default_limit() -> i64 {
    50
}

/// GET /api/chat/sessions
pub async fn list_sessions(
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let sessions = store.list_sessions(&st.db, q.limit.clamp(1, 200), &q.q)?;
    Ok(Json(json!({ "sessions": sessions })))
}

/// GET /api/chat/sessions/{id}
pub async fn get_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let session = store
        .get(&st.db, &id)?
        .ok_or_else(|| AppError::not_found(format!("会话不存在: {id}")))?;
    let usage = store.usage_stats(&st.db, &id)?;
    let messages: Vec<Value> = session
        .messages
        .iter()
        .map(|m| {
            json!({
                "role": m.role,
                "content": m.content,
                "tool_calls": m.tool_calls.clone().unwrap_or_default(),
                "tool_call_id": m.tool_call_id,
                "tool_name": m.tool_name,
            })
        })
        .collect();
    Ok(Json(json!({
        "session_id": session.id,
        "title": session.title,
        "updated_at": session.updated_at,
        "summary": session.summary,
        "usage": usage,
        "messages": messages,
    })))
}

#[derive(Deserialize)]
pub struct PatchReq {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// PATCH /api/chat/sessions/{id}
pub async fn patch_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PatchReq>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    if let Some(title) = req.title {
        store.rename(&st.db, &id, &title)?;
    }
    if let Some(pinned) = req.pinned {
        store.set_pinned(&st.db, &id, pinned)?;
    }
    Ok(Json(json!({ "ok": true, "id": id })))
}

/// DELETE /api/chat/sessions/{id}
pub async fn delete_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let deleted = store.delete(&st.db, &id)?;
    Ok(Json(json!({ "deleted": if deleted { id } else { String::new() } })))
}

/// POST /api/chat/sessions/{id}/clear
pub async fn clear_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let n = store.clear_messages(&st.db, &id)?;
    Ok(Json(json!({ "deleted_messages": n })))
}

#[derive(Deserialize)]
pub struct BatchDeleteReq {
    #[serde(default)]
    pub ids: Vec<String>,
}

/// POST /api/chat/sessions/batch_delete
pub async fn batch_delete(
    State(st): State<AppState>,
    Json(req): Json<BatchDeleteReq>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let n = store.batch_delete(&st.db, &req.ids)?;
    Ok(Json(json!({ "deleted": n })))
}

#[derive(Deserialize)]
pub struct ExportQuery {
    #[serde(default = "default_format")]
    pub format: String,
}

fn default_format() -> String {
    "md".into()
}

/// GET /api/chat/sessions/{id}/export —— md（可读报告）/ json（可再导入）
pub async fn export_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> AppResult<axum::response::Response> {
    let store = SessionStore::new();
    if q.format == "json" {
        let data = store
            .export_json(&st.db, &id)?
            .ok_or_else(|| AppError::not_found("会话不存在"))?;
        return Ok(Json(data).into_response());
    }
    let text = store.export_markdown(&st.db, &id)?;
    if text.is_empty() {
        return Err(AppError::not_found("会话不存在"));
    }
    let resp = (
        [
            ("content-type", "text/markdown; charset=utf-8".to_string()),
            (
                "content-disposition",
                format!("attachment; filename=\"session-{id}.md\""),
            ),
        ],
        text,
    )
        .into_response();
    Ok(resp)
}

#[derive(Deserialize)]
pub struct ImportReq {
    pub data: Value,
}

/// POST /api/chat/import —— 导入会话 JSON，生成新会话
pub async fn import_session(
    State(st): State<AppState>,
    Json(req): Json<ImportReq>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let result = store.import_session(&st.db, &req.data)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/chat/sessions/{id}/share
pub async fn share_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let result = store.share(&st.db, &id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// DELETE /api/chat/sessions/{id}/share
pub async fn revoke_share(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let result = store.revoke_share(&st.db, &id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// POST /api/chat/sessions —— 新建空会话
pub async fn create_session(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let s = store.create(&st.db, "新对话")?;
    Ok(Json(json!({
        "session_id": s.id,
        "title": s.title,
        "created_at": s.created_at,
    })))
}

#[derive(Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// GET /api/chat/usage
pub async fn usage(
    State(st): State<AppState>,
    Query(q): Query<UsageQuery>,
) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let rt = st.rt();
    let global = store.global_usage(&st.db)?;
    let session_stats = match q.session_id.as_deref() {
        Some(id) => Some(store.usage_stats(&st.db, id)?),
        None => None,
    };
    let pressure = match q.session_id.as_deref() {
        Some(id) => store.get(&st.db, id)?.map(|s| context_pressure(&st, &s)),
        None => None,
    };
    Ok(Json(json!({
        "model": rt.llm_model,
        "context_window": rt.llm_context_window,
        "threshold_ratio": rt.compaction_threshold_ratio,
        "retain_ratio": rt.compaction_retain_ratio,
        "global": global,
        "session": session_stats.map(|s| json!({
            "session_id": q.session_id,
            "llm_calls": s.llm_calls,
            "prompt_tokens": s.prompt_tokens,
            "completion_tokens": s.completion_tokens,
            "cache_hit_tokens": s.cache_hit_tokens,
            "cache_miss_tokens": s.cache_miss_tokens,
            "cache_hit_rate": s.cache_hit_rate,
            "compact_count": s.compact_count,
        })),
        "pressure": pressure,
        "preheat": crate::llm::preheat::status(&st),
    })))
}

#[derive(Deserialize)]
pub struct ApproveReq {
    pub approval_id: String,
    pub approved: bool,
}

/// POST /api/chat/approve —— 动作工具授权决策
pub async fn approve(Json(req): Json<ApproveReq>) -> AppResult<Json<Value>> {
    let hit = crate::agent::approvals::resolve(&req.approval_id, req.approved);
    if !hit {
        return Err(AppError::not_found(format!("授权请求不存在或已超时: {}", req.approval_id)));
    }
    Ok(Json(json!({ "approval_id": req.approval_id, "approved": req.approved })))
}

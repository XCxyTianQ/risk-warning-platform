//! 对话接口：SSE 流式对话 + 会话管理 + 用量。

use std::convert::Infallible;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
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
}

/// POST /api/chat/stream —— SSE 流式对话
pub async fn stream(
    State(st): State<AppState>,
    Json(req): Json<StreamReq>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    if req.message.trim().is_empty() {
        return Err(AppError::bad_request("message 不能为空"));
    }
    let store = SessionStore::new();
    let session = store.get_or_create(&st.db, req.session_id.as_deref())?;
    let events = run_agent(st.clone(), session, req.message, req.preset_id);
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
    let messages: Vec<Value> = session
        .messages
        .iter()
        .map(|m| {
            json!({
                "role": m.role,
                "content": m.content,
                "tool_calls": m.tool_calls,
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
    let global = st.db.with(|conn| {
        let row = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(llm_calls),0), COALESCE(SUM(prompt_tokens),0),
                    COALESCE(SUM(completion_tokens),0), COALESCE(SUM(cache_hit_tokens),0),
                    COALESCE(SUM(cache_miss_tokens),0)
             FROM chat_session",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )?;
        Ok(row)
    })?;
    let total = global.4 + global.5;
    let session_stats = match q.session_id.as_deref() {
        Some(id) => Some(store.usage_stats(&st.db, id)?),
        None => None,
    };
    let pressure = match q.session_id.as_deref() {
        Some(id) => store.get(&st.db, id)?.map(|s| context_pressure(&st, &s)),
        None => None,
    };
    Ok(Json(json!({
        "model": st.cfg.llm_model,
        "context_window": st.cfg.llm_context_window,
        "threshold_ratio": st.cfg.compaction_threshold_ratio,
        "retain_ratio": st.cfg.compaction_retain_ratio,
        "global": {
            "sessions": global.0,
            "llm_calls": global.1,
            "prompt_tokens": global.2,
            "completion_tokens": global.3,
            "cache_hit_tokens": global.4,
            "cache_miss_tokens": global.5,
            "cache_hit_rate": if total > 0 { ((global.4 as f64 / total as f64) * 10000.0).round() / 10000.0 } else { 0.0 },
        },
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

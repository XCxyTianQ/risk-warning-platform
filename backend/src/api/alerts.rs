//! 预警中心接口：列表 / 统计 / 生成 / 处置 / 报告。

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::services::alerts;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub enterprise_id: i64,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    200
}

/// GET /api/alerts
pub async fn list(State(st): State<AppState>, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let result = alerts::list_alerts(
        &st.db,
        if q.status.is_empty() { None } else { Some(q.status.as_str()) },
        if q.level.is_empty() { None } else { Some(q.level.as_str()) },
        if q.enterprise_id > 0 { Some(q.enterprise_id) } else { None },
        q.limit.clamp(1, 500),
    )?;
    Ok(Json(result))
}

/// GET /api/alerts/summary
pub async fn summary(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(alerts::summary(&st.db)?))
}

#[derive(Deserialize)]
pub struct GenerateReq {
    #[serde(default)]
    pub enterprise_id: Option<i64>,
}

/// POST /api/alerts/generate
pub async fn generate(
    State(st): State<AppState>,
    Json(req): Json<GenerateReq>,
) -> AppResult<Json<Value>> {
    let result = match req.enterprise_id {
        Some(id) => alerts::generate_for_enterprise(&st.db, id, "scoring")?,
        None => alerts::generate_all(&st.db, "scoring")?,
    };
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct HandleReq {
    pub action: String,
    #[serde(default)]
    pub handler: String,
    #[serde(default)]
    pub note: String,
}

/// POST /api/alerts/{id}/handle
pub async fn handle(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<HandleReq>,
) -> AppResult<Json<Value>> {
    let result = alerts::handle_alert(&st.db, id, &req.action, &req.handler, &req.note)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// GET /api/alerts/{id}/report —— Markdown 报告
pub async fn report(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let text = alerts::report_markdown(&st.db, id)?;
    if text.is_empty() {
        return Err(AppError::not_found(format!("预警不存在: {id}")));
    }
    Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], text))
}

//! 金融分析接口：概览 / 单企业分析 / Markdown 报告。

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::services::finance as fin;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct YearsQuery {
    #[serde(default = "default_years")]
    pub years: usize,
    #[serde(default = "default_true")]
    pub peers: bool,
}

fn default_years() -> usize {
    5
}

fn default_true() -> bool {
    true
}

/// GET /api/finance/overview
pub async fn overview(
    State(st): State<AppState>,
    Query(q): Query<YearsQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(fin::overview(&st.db, q.years.clamp(1, 10))?))
}

/// GET /api/finance/{id}/analysis
pub async fn analysis(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<YearsQuery>,
) -> AppResult<Json<Value>> {
    let data = fin::analysis(&st.db, id, q.years.clamp(1, 10), q.peers)?;
    if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(data))
}

/// GET /api/finance/{id}/report —— 确定性 Markdown 报告
pub async fn report(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<YearsQuery>,
) -> AppResult<impl IntoResponse> {
    let text = fin::report_markdown(&st.db, id, q.years.clamp(1, 10))?;
    Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], text))
}

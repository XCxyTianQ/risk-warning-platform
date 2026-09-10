//! 分享访问：`GET /api/share/{token}`（只读会话视图，无需登录）。

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::agent::session::SessionStore;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// GET /api/share/{token}
pub async fn get_shared(State(st): State<AppState>, Path(token): Path<String>) -> AppResult<Json<Value>> {
    let store = SessionStore::new();
    let data = store
        .get_shared(&st.db, &token)?
        .ok_or_else(|| AppError::not_found("分享链接不存在或已撤销"))?;
    Ok(Json(data))
}

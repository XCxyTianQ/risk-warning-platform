//! 插件（手搓 HTTP 工具）与 Agent 预设 API：`/api/plugins/*`。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::services::presets;
use crate::state::AppState;

// ---------- 插件（自定义工具） ----------

/// GET /api/plugins/tools
pub async fn list_tools(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(presets::list_custom_tools(&st.db)?))
}

/// POST /api/plugins/tools
pub async fn create_tool(
    State(st): State<AppState>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = presets::create_custom_tool(&st.db, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// PATCH /api/plugins/tools/{id}
pub async fn update_tool(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = presets::update_custom_tool(&st.db, id, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// DELETE /api/plugins/tools/{id}
pub async fn delete_tool(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = presets::delete_custom_tool(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/plugins/tools/{id}/test —— 用给的参数实调一次（设置面板"测试"按钮）
pub async fn test_tool(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    body: Option<Json<Value>>,
) -> AppResult<Json<Value>> {
    let row = presets::custom_tool_by_id(&st.db, id)?
        .ok_or_else(|| AppError::not_found(format!("工具不存在: {id}")))?;
    let args = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    Ok(Json(presets::run_custom_tool(&row, &args).await))
}

// ---------- Agent 预设 ----------

/// GET /api/plugins/presets
pub async fn list_presets(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(presets::list_presets(&st.db)?))
}

/// POST /api/plugins/presets
pub async fn create_preset(
    State(st): State<AppState>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = presets::create_preset(&st.db, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// PATCH /api/plugins/presets/{id}
pub async fn update_preset(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = presets::update_preset(&st.db, id, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// DELETE /api/plugins/presets/{id}
pub async fn delete_preset(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let result = presets::delete_preset(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/plugins/presets/seed —— 补齐内置预设（幂等）
pub async fn seed_presets(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let created = presets::seed_builtin_presets(&st.db)?;
    Ok(Json(json!({ "created": created })))
}

/// GET /api/plugins/presets/{id}/export
pub async fn export_preset(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let result = presets::export_preset(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// GET /api/plugins/export —— 导出全部预设 + 技能 + 插件
pub async fn export_all(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(presets::export_all(&st.db)?))
}

#[derive(Deserialize)]
pub struct ImportReq {
    pub data: Value,
    #[serde(default = "default_strategy")]
    pub strategy: String,
}

fn default_strategy() -> String {
    "rename".into()
}

/// POST /api/plugins/import
pub async fn import_bundle(
    State(st): State<AppState>,
    Json(req): Json<ImportReq>,
) -> AppResult<Json<Value>> {
    let result = presets::import_bundle(&st.db, &req.data, &req.strategy)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

//! 技能库 API：`/api/skills`。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::services::skills;
use crate::state::AppState;

/// GET /api/skills
pub async fn list(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(skills::list(&st.db, false)?))
}

#[derive(Deserialize)]
pub struct SkillIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
}

/// POST /api/skills
pub async fn create(
    State(st): State<AppState>,
    Json(body): Json<SkillIn>,
) -> AppResult<Json<Value>> {
    let result = skills::create(&st.db, &body.name, &body.description, &body.content)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// PATCH /api/skills/{id}
pub async fn update(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = skills::update(&st.db, id, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// DELETE /api/skills/{id}
pub async fn delete(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = skills::delete(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/skills/seed —— 补齐内置技能（幂等）
pub async fn seed(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let created = skills::seed_builtin(&st.db)?;
    Ok(Json(json!({ "created": created })))
}

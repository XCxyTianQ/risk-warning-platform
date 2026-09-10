//! 设置 API（DSH 风格设置面板数据源）：`/api/settings/*`。
//!
//! 保存后立即覆盖 `AppState.rt`（无需重启）；切换模型/端点后后台重新预热前缀。

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::prompt::SYSTEM_PROMPT;
use crate::agent::tools::build_registry;
use crate::error::{AppError, AppResult};
use crate::services::settings as svc;
use crate::state::AppState;

/// GET /api/settings
pub async fn get(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(svc::get_view(&st.rt())))
}

/// GET /api/settings/providers
pub async fn providers() -> Json<Value> {
    Json(json!({ "providers": svc::providers() }))
}

#[derive(Deserialize)]
pub struct ModelsIn {
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// POST /api/settings/models —— 按端点拉取可用模型列表
pub async fn models(
    State(st): State<AppState>,
    Json(body): Json<ModelsIn>,
) -> AppResult<Json<Value>> {
    let rt = st.rt();
    Ok(Json(
        svc::list_models(&body.base_url, body.api_key.as_deref().unwrap_or(""), &rt).await,
    ))
}

#[derive(Deserialize)]
pub struct UpdateIn {
    #[serde(default)]
    pub values: Value,
}

/// PUT /api/settings —— 保存并立即生效
pub async fn update(
    State(st): State<AppState>,
    Json(body): Json<UpdateIn>,
) -> AppResult<Json<Value>> {
    let payload = if body.values.is_object() { body.values } else { json!({}) };
    let mut rt = st.rt();
    let (applied, errors) = svc::update(&st.db, &mut rt, &payload)?;
    let switched = ["llm_model", "llm_base_url", "preheat_enabled"]
        .iter()
        .any(|k| applied.get(*k).is_some());
    st.set_rt(rt);
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors.join("; ")));
    }
    // 切换模型/端点后重新预热前缀（后台，不阻塞响应）
    if switched && st.rt().preheat_enabled {
        crate::llm::preheat::warm_background(
            st.clone(),
            SYSTEM_PROMPT.to_string(),
            build_registry().definitions(),
            "settings",
        );
    }
    Ok(Json(json!({
        "ok": true,
        "applied": applied,
        "settings": svc::get_view(&st.rt()),
    })))
}

/// POST /api/settings/preheat —— 手动预热提示词缓存
pub async fn trigger_preheat(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let tools = build_registry().definitions();
    Ok(Json(
        crate::llm::preheat::warm(&st, SYSTEM_PROMPT, tools, true, "manual").await,
    ))
}

/// GET /api/settings/preheat —— 预热状态
pub async fn preheat_status(State(st): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(crate::llm::preheat::status(&st)))
}

/// POST /api/settings/reset —— 清除 DB 覆盖
pub async fn reset(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let result = svc::reset(&st.db)?;
    Ok(Json(result))
}

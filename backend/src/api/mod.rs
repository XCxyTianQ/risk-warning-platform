//! HTTP 路由装配：`/api/*` + 前端静态资源（SPA fallback）。
//!
//! 与 Python 版保持一致：后端同时托管 `web/dist`，未知路径回落到 `index.html`。

pub mod chat;
pub mod dashboard;
pub mod enterprises;

use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        // 企业档案
        .route("/enterprises", get(enterprises::list))
        .route("/enterprise/{id}", get(enterprises::get_one))
        // 风险总览
        .route("/dashboard/summary", get(dashboard::summary))
        // 对话（SSE）
        .route("/chat/stream", post(chat::stream))
        .route("/chat/sessions", get(chat::list_sessions))
        .route(
            "/chat/sessions/{id}",
            get(chat::get_session).patch(chat::patch_session).delete(chat::delete_session),
        )
        .route("/chat/sessions/{id}/clear", post(chat::clear_session))
        .route("/chat/sessions/batch_delete", post(chat::batch_delete))
        .route("/chat/usage", get(chat::usage))
        .with_state(state.clone());

    let index = state.cfg.web_dist.join("index.html");
    let spa = ServeDir::new(&state.cfg.web_dist).fallback(ServeFile::new(index));

    Router::new().nest("/api", api).fallback_service(spa).layer(
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any),
    )
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "risk-warning-platform",
        "version": env!("CARGO_PKG_VERSION"),
        "runtime": "rust",
    }))
}

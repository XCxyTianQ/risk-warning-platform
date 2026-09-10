//! HTTP 路由装配：`/api/*` + 前端静态资源（SPA fallback）。
//!
//! 与 Python 版保持一致：后端同时托管 `web/dist`，未知路径回落到 `index.html`。

pub mod alerts;
pub mod chat;
pub mod dashboard;
pub mod enterprises;
pub mod finance;

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
        .route("/enterprises", get(enterprises::list).post(enterprises::create))
        .route(
            "/enterprise/{id}",
            get(enterprises::get_one).delete(enterprises::delete),
        )
        .route("/enterprise/{id}/refresh", post(enterprises::refresh))
        .route("/resolve_stock", get(enterprises::resolve_stock))
        .route("/datasources", get(enterprises::datasources_status))
        // 风险总览
        .route("/dashboard/summary", get(dashboard::summary))
        // 金融分析
        .route("/finance/overview", get(finance::overview))
        .route("/finance/{id}/analysis", get(finance::analysis))
        .route("/finance/{id}/report", get(finance::report))
        // 预警中心
        .route("/alerts", get(alerts::list))
        .route("/alerts/summary", get(alerts::summary))
        .route("/alerts/generate", post(alerts::generate))
        .route("/alerts/{id}/handle", post(alerts::handle))
        .route("/alerts/{id}/report", get(alerts::report))
        // 对话（SSE）
        .route("/chat/stream", post(chat::stream))
        .route("/chat/approve", post(chat::approve))
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

//! HTTP 路由装配：`/api/*` + 前端静态资源（SPA fallback）。
//!
//! 与 Python 版保持一致：后端同时托管 `web/dist`，未知路径回落到 `index.html`。

pub mod enterprises;

use axum::response::Json;
use axum::routing::get;
use axum::Router;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/enterprises", get(enterprises::list))
        .route("/enterprise/{id}", get(enterprises::get_one))
        .with_state(state.clone());

    let index = state.cfg.web_dist.join("index.html");
    let spa = ServeDir::new(&state.cfg.web_dist).fallback(ServeFile::new(index));

    Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .layer(
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

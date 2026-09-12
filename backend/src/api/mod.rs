//! HTTP 路由装配：`/api/*` + 前端静态资源（SPA fallback）。
//!
//! 与 Python 版保持一致：后端同时托管 `web/dist`，未知路径回落到 `index.html`。

pub mod alerts;
pub mod chat;
pub mod dashboard;
pub mod enterprises;
pub mod finance;
pub mod mcp;
pub mod plugins;
pub mod settings;
pub mod share;
pub mod skills;
pub mod tables;

use axum::response::Json;
use axum::routing::{get, patch, post};
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
        .route("/enterprise/{id}/risk", get(enterprises::risk))
        .route(
            "/enterprises/analyze_by_name",
            post(enterprises::analyze_by_name),
        )
        .route("/resolve_stock", get(enterprises::resolve_stock))
        .route("/datasources", get(enterprises::datasources_status))
        // 风险总览
        .route("/dashboard/summary", get(dashboard::summary))
        .route("/risk-facts", get(dashboard::risk_facts))
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
        .route(
            "/chat/sessions",
            get(chat::list_sessions).post(chat::create_session),
        )
        .route("/chat/sessions/batch_delete", post(chat::batch_delete))
        .route(
            "/chat/sessions/{id}",
            get(chat::get_session)
                .patch(chat::patch_session)
                .delete(chat::delete_session),
        )
        .route("/chat/sessions/{id}/clear", post(chat::clear_session))
        .route("/chat/sessions/{id}/export", get(chat::export_session))
        .route(
            "/chat/sessions/{id}/share",
            post(chat::share_session).delete(chat::revoke_share),
        )
        .route("/chat/import", post(chat::import_session))
        .route("/chat/usage", get(chat::usage))
        .route("/share/{token}", get(share::get_shared))
        // 设置
        .route("/settings", get(settings::get).put(settings::update))
        .route("/settings/providers", get(settings::providers))
        .route("/settings/models", post(settings::models))
        .route(
            "/settings/preheat",
            get(settings::preheat_status).post(settings::trigger_preheat),
        )
        .route("/settings/reset", post(settings::reset))
        // 技能库
        .route("/skills", get(skills::list).post(skills::create))
        .route("/skills/seed", post(skills::seed))
        .route("/skills/{id}", patch(skills::update).delete(skills::delete))
        // 插件（手搓工具）与 Agent 预设
        .route(
            "/plugins/tools",
            get(plugins::list_tools).post(plugins::create_tool),
        )
        .route(
            "/plugins/tools/{id}",
            patch(plugins::update_tool).delete(plugins::delete_tool),
        )
        .route("/plugins/tools/{id}/test", post(plugins::test_tool))
        .route(
            "/plugins/presets",
            get(plugins::list_presets).post(plugins::create_preset),
        )
        .route("/plugins/presets/seed", post(plugins::seed_presets))
        .route(
            "/plugins/presets/{id}",
            patch(plugins::update_preset).delete(plugins::delete_preset),
        )
        .route("/plugins/presets/{id}/export", get(plugins::export_preset))
        .route("/plugins/export", get(plugins::export_all))
        .route("/plugins/import", post(plugins::import_bundle))
        // MCP
        .route("/mcp/servers", get(mcp::list).post(mcp::create))
        .route(
            "/mcp/servers/{id}",
            patch(mcp::update).delete(mcp::delete),
        )
        .route("/mcp/servers/{id}/test", post(mcp::test_server))
        .route("/mcp/servers/{id}/sync", post(mcp::sync_server))
        .route("/mcp", post(mcp::rpc_endpoint))
        // 表格对象（在线创建 / 编辑 / 入库）
        .route("/tables", get(tables::list).post(tables::create))
        .route("/tables/templates", get(tables::templates))
        .route(
            "/tables/{id}",
            get(tables::get_one).patch(tables::update).delete(tables::delete),
        )
        .route("/tables/{id}/cells", post(tables::write_cells))
        .route("/tables/{id}/validate", post(tables::validate))
        .route("/tables/{id}/preview", get(tables::preview))
        .route("/tables/{id}/ingest", post(tables::ingest))
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

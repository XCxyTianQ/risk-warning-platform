//! 企业经营风险预警平台 · 后端（Rust 重写版）
//!
//! 与 Python 版的关系：API 契约、表结构、数据目录约定保持一致，
//! 前端与 Electron 无需改动（只需把拉起后端的命令换成本二进制）。
//!
//! 启动约定（对齐 desktop_entry.py）：
//!   risk-warning-backend --port 0 --data-dir <DIR> --web-dist <DIR>
//!   - 端口 0：自动分配，并在 stdout 打印 `RWP_PORT=<port>`
//!   - 数据目录：SQLite 落在 `<data-dir>/platform.db`

mod agent;
mod api;
mod config;
mod datasources;
mod db;
mod error;
mod llm;
mod services;
mod state;
mod util;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::net::TcpListener;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    // 诊断入口：--probe <dimension> --code <code>（不启动服务，直接跑数据源并打印结果）
    let argv: Vec<String> = std::env::args().collect();
    if let Some(pos) = argv.iter().position(|a| a == "--probe") {
        let dim = argv.get(pos + 1).cloned().unwrap_or_else(|| "finance".into());
        let code = argv
            .iter()
            .position(|a| a == "--code")
            .and_then(|p| argv.get(p + 1).cloned())
            .unwrap_or_else(|| "600518".into());
        if dim == "codes" {
            let n = datasources::ensure_code_table(true).await?;
            println!("code table size = {n}");
            println!("name_of(600518) = {}", datasources::name_of("600518"));
            println!("resolve_code_strict(康美药业) = {:?}", datasources::resolve_code_strict("康美药业"));
            return Ok(());
        }
        let result = datasources::fetch_dimension(&code, &dim).await;
        if dim == "legal" {
            // 诊断：打印巨潮原始 records（解析口径不一致时用于定位）
            if let Ok(raw) = datasources::cninfo::debug_raw(&code).await {
                println!("cninfo raw (前 600 字)：{}", raw.chars().take(600).collect::<String>());
            }
        }
        println!(
            "dimension={} source={} error={:?} gap={:?} finance={} news={} legal={}",
            result.dimension,
            result.source,
            result.error,
            result.gap,
            result.finance.len(),
            result.news.len(),
            result.legal.len()
        );
        if let Some(first) = result.finance.first() {
            println!("finance[0] = {}", serde_json::to_string_pretty(&serde_json::json!({
                "year": first.year,
                "revenue": first.revenue,
                "net_profit": first.net_profit,
                "debt_ratio": first.debt_ratio,
                "total_assets": first.total_assets,
                "metrics": first.metrics.len(),
            }))?);
        }
        if let Some(first) = result.legal.first() {
            println!("legal[0] = {}", serde_json::to_string_pretty(&serde_json::json!({
                "title": first.title,
                "amount": first.amount,
                "status": first.status,
            }))?);
        }
        if let Some(first) = result.news.first() {
            println!("news[0] = {}", serde_json::to_string_pretty(&serde_json::json!({
                "title": first.title,
                "published_at": first.published_at,
                "sentiment": first.sentiment,
            }))?);
        }
        return Ok(());
    }

    let cfg = Config::from_args_and_env()?;

    // 先建库（空库时灌样例），再绑定端口，最后打印端口供 Electron 读取
    let db = db::init(&cfg).context("数据库初始化失败")?;

    let addr = format!("{}:{}", cfg.host, cfg.bind_port());
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("监听失败：{addr}"))?;
    let port = listener.local_addr()?.port();

    println!("RWP_PORT={port}");
    println!("RWP_DATA_DIR={}", cfg.data_dir.display());
    println!(
        "RWP_WEB_DIST={} (exists={})",
        cfg.web_dist.display(),
        cfg.web_dist.join("index.html").exists()
    );

    let state = AppState { db, cfg: Arc::new(cfg) };
    let app = api::router(state);

    println!("[server] listening on http://127.0.0.1:{port}");
    axum::serve(listener, app).await.context("HTTP 服务异常退出")?;
    Ok(())
}

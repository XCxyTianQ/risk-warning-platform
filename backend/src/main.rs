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
mod db;
mod error;
mod llm;
mod services;
mod state;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::net::TcpListener;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
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

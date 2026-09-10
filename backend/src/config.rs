//! 运行时配置：命令行参数 + 环境变量（对齐原 Python 版 desktop_entry.py 的约定）。
//!
//! 由 Electron 主进程拉起时传入：
//!     risk-warning-backend --port 0 --data-dir <用户数据目录> --web-dist <resources/web>
//! 端口为 0 时自动选空闲端口，并在 stdout 打印 `RWP_PORT=<port>`（Electron 读取该行）。

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub host: IpAddr,
    /// 0 表示自动选空闲端口
    pub port: u16,
    pub data_dir: PathBuf,
    pub web_dist: PathBuf,
    pub samples_dir: PathBuf,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub llm_max_tokens: i64,
    pub llm_context_window: i64,
    pub compaction_enabled: bool,
    pub compaction_threshold_ratio: f64,
    pub compaction_retain_ratio: f64,
    pub compaction_summary_max_tokens: i64,
    pub agent_require_approval: bool,
    pub agent_approval_timeout: u64,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default)
}

/// 仓库根目录（开发模式下的相对路径解析基准）
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

impl Config {
    pub fn from_args_and_env() -> Result<Self> {
        let mut host: IpAddr = "127.0.0.1".parse().unwrap();
        let mut port: u16 = env_parse("RWP_PORT", 0);
        let mut data_dir = std::env::var("RWP_DATA_DIR").unwrap_or_default();
        let mut web_dist = std::env::var("RWP_WEB_DIST").unwrap_or_default();

        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--host" if i + 1 < args.len() => {
                    host = args[i + 1].parse().context("--host 解析失败")?;
                    i += 2;
                }
                "--port" if i + 1 < args.len() => {
                    port = args[i + 1].parse().context("--port 解析失败")?;
                    i += 2;
                }
                "--data-dir" if i + 1 < args.len() => {
                    data_dir = args[i + 1].clone();
                    i += 2;
                }
                "--web-dist" if i + 1 < args.len() => {
                    web_dist = args[i + 1].clone();
                    i += 2;
                }
                "--help" | "-h" => {
                    println!(
                        "risk-warning-backend [--host 127.0.0.1] [--port 0] [--data-dir DIR] [--web-dist DIR]"
                    );
                    std::process::exit(0);
                }
                other => {
                    eprintln!("忽略未知参数：{other}");
                    i += 1;
                }
            }
        }

        let root = repo_root();
        let data_dir = if data_dir.is_empty() {
            root.join("data")
        } else {
            PathBuf::from(data_dir)
        };
        let web_dist = if web_dist.is_empty() {
            let candidate = root.join("web").join("dist");
            if candidate.join("index.html").exists() {
                candidate
            } else {
                root.join("desktop").join("resources").join("web")
            }
        } else {
            PathBuf::from(web_dist)
        };
        let samples_dir = std::env::var("RWP_SAMPLES_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root.join("data").join("samples"));

        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("无法创建数据目录 {}", data_dir.display()))?;

        Ok(Self {
            host,
            port,
            data_dir,
            web_dist,
            samples_dir,
            llm_base_url: env_or("RWP_LLM_BASE_URL", "http://127.0.0.1:9000/v1"),
            llm_api_key: env_or("RWP_LLM_API_KEY", "mock-key"),
            llm_model: env_or("RWP_LLM_MODEL", "mock"),
            llm_max_tokens: env_parse("RWP_LLM_MAX_TOKENS", 4096),
            llm_context_window: env_parse("RWP_LLM_CONTEXT_WINDOW", 128_000),
            compaction_enabled: env_parse("RWP_COMPACTION_ENABLED", true),
            compaction_threshold_ratio: env_parse("RWP_COMPACTION_THRESHOLD_RATIO", 0.8),
            compaction_retain_ratio: env_parse("RWP_COMPACTION_RETAIN_RATIO", 0.16),
            compaction_summary_max_tokens: env_parse("RWP_COMPACTION_SUMMARY_MAX_TOKENS", 1024),
            agent_require_approval: env_parse("RWP_AGENT_REQUIRE_APPROVAL", true),
            agent_approval_timeout: env_parse("RWP_AGENT_APPROVAL_TIMEOUT", 300),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("platform.db")
    }

    /// 端口 0 → 交给监听器分配（见 main.rs：先 bind 再报端口）
    pub fn bind_port(&self) -> u16 {
        self.port
    }
}

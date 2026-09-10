//! 共享 HTTP 客户端（统一 UA / 超时 / 解压 / 失败重试）。
//!
//! 实测：东财等站点会偶发提前关闭连接（rustls 报 `peer closed connection without
//! sending TLS close_notify`），因此所有请求带退避重试。

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_ATTEMPTS: usize = 3;

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(UA)
        .pool_max_idle_per_host(1)
        .build()
        .unwrap_or_default()
}

async fn backoff(attempt: usize) {
    tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
}

pub async fn get_json(url: &str, params: &[(&str, &str)]) -> Result<Value> {
    get_json_h(url, params, &[]).await
}

/// 带自定义请求头的 GET（如东财行情接口需要 Referer）
pub async fn get_json_h(url: &str, params: &[(&str, &str)], headers: &[(&str, &str)]) -> Result<Value> {
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match get_json_once(url, params, headers).await {
            Ok(v) => return Ok(v),
            Err(err) => {
                last_err = Some(err);
                if attempt < MAX_ATTEMPTS {
                    backoff(attempt).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("请求失败：{url}")))
}

async fn get_json_once(url: &str, params: &[(&str, &str)], headers: &[(&str, &str)]) -> Result<Value> {
    let mut req = client().get(url).query(params);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.with_context(|| format!("请求失败：{url}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("HTTP {}：{}", status.as_u16(), text.chars().take(200).collect::<String>());
    }
    serde_json::from_str(&text).with_context(|| {
        format!(
            "响应不是合法 JSON（前 200 字）：{}",
            text.chars().take(200).collect::<String>()
        )
    })
}

/// 东方财富的 JSONP 接口：去掉回调包装后解析（当前数据源未使用，保留能力）
#[allow(dead_code)]
pub async fn get_jsonp(url: &str, params: &[(&str, &str)], callback: &str) -> Result<Value> {
    let resp = client()
        .get(url)
        .query(params)
        .header("Referer", "https://so.eastmoney.com/")
        .send()
        .await
        .with_context(|| format!("请求失败：{url}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("HTTP {}：{}", status.as_u16(), text.chars().take(200).collect::<String>());
    }
    let body = text
        .trim()
        .strip_prefix(callback)
        .map(|s| s.trim_start_matches('(').trim_end_matches(')'))
        .unwrap_or_else(|| text.trim());
    serde_json::from_str(body).context("JSONP 解析失败")
}

pub async fn post_json(url: &str, params: &[(&str, &str)], headers: &[(&str, &str)]) -> Result<Value> {
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        let mut req = client().post(url).query(params);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if status.is_success() {
                    match serde_json::from_str(&text) {
                        Ok(v) => return Ok(v),
                        Err(err) => last_err = Some(anyhow::anyhow!("响应不是合法 JSON：{err}")),
                    }
                } else {
                    last_err = Some(anyhow::anyhow!(
                        "HTTP {}：{}",
                        status.as_u16(),
                        text.chars().take(200).collect::<String>()
                    ));
                }
            }
            Err(err) => last_err = Some(anyhow::anyhow!("请求失败：{err}")),
        }
        if attempt < MAX_ATTEMPTS {
            backoff(attempt).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("请求失败：{url}")))
}

//! 提示词缓存预热（prompt cache preheat）。
//!
//! 原理：提供方按请求 token 序列的**前缀**做 KV Cache。我们的静态前缀
//! （`SYSTEM_PROMPT` + 全部工具 schema，约 7k token）在每个请求里都出现，
//! 但进程启动后/新会话的第一个请求仍要全价处理一次这段前缀。
//!
//! 做法：用**完全相同**的 system 与 tools 发一个最小请求（max_tokens=1），
//! 把这段前缀提前写进提供方缓存；之后真实请求的前缀部分即按缓存价处理。
//!
//! 与 Python 版 `app/llm/preheat.py` 对齐：TTL 内不重复预热、失败不影响主流程、
//! 本地 mock 端点直接跳过。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::llm::{LlmClient, LlmConfig, Usage};
use crate::state::AppState;

/// 预热请求的 user 内容（不参与前缀匹配，仅需构成一次合法请求）
pub const WARM_USER_TEXT: &str = "预热";

#[derive(Debug, Default, Clone)]
pub struct Warmer {
    pub last_warm_at: f64,
    pub last_label: String,
    pub warm_count: i64,
    pub last_usage: Option<Usage>,
    pub last_error: String,
    pub last_hit_tokens: i64,
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

impl Warmer {
    pub fn is_fresh(&self, ttl_seconds: i64) -> bool {
        self.last_warm_at > 0.0 && (now_secs() - self.last_warm_at) < ttl_seconds as f64
    }

    pub fn status(&self, enabled: bool, ttl_seconds: i64) -> Value {
        json!({
            "enabled": enabled,
            "warm_count": self.warm_count,
            "last_warm_at": self.last_warm_at,
            "last_warm_ago": if self.last_warm_at > 0.0 {
                json!(((now_secs() - self.last_warm_at) * 10.0).round() / 10.0)
            } else {
                Value::Null
            },
            "last_label": self.last_label,
            "last_hit_tokens": self.last_hit_tokens,
            "ttl_seconds": ttl_seconds,
            "last_error": self.last_error,
        })
    }
}

/// 预热状态（无副作用），供 `/api/settings/preheat` 与 `/api/chat/usage` 使用
pub fn status(state: &AppState) -> Value {
    let rt = state.rt();
    let warmer = state.warmer.lock().expect("warmer lock");
    warmer.status(rt.preheat_enabled, rt.preheat_ttl_seconds)
}

/// 预热静态前缀：返回状态字典；失败不抛异常（与 Python 版语义一致）。
pub async fn warm(state: &AppState, system_prompt: &str, tools: Vec<Value>, force: bool, label: &str) -> Value {
    let rt = state.rt();
    if !rt.preheat_enabled {
        return json!({ "skipped": "preheat disabled" });
    }
    if rt.is_local_endpoint() {
        return json!({ "skipped": "本地 mock 端点无需预热" });
    }
    {
        let warmer = state.warmer.lock().expect("warmer lock");
        if warmer.is_fresh(rt.preheat_ttl_seconds) && !force {
            let ago = ((now_secs() - warmer.last_warm_at) * 10.0).round() / 10.0;
            return json!({ "skipped": format!("缓存仍新鲜（{ago}s 前预热）") });
        }
    }

    let client = LlmClient::new(LlmConfig {
        base_url: rt.llm_base_url.clone(),
        api_key: rt.llm_api_key.clone(),
        model: rt.llm_model.clone(),
        max_tokens: 1,
        timeout_s: 60,
        max_retries: 1,
        disable_thinking: false,
    });
    let messages = vec![
        json!({ "role": "system", "content": system_prompt }),
        json!({ "role": "user", "content": WARM_USER_TEXT }),
    ];
    let result = client.chat(messages, tools, Some(1)).await;

    let mut warmer = state.warmer.lock().expect("warmer lock");
    match result {
        Ok(_) => {
            let usage = client.last_usage();
            warmer.last_hit_tokens = usage.cache_hit_tokens;
            warmer.last_usage = Some(usage.clone());
            warmer.last_warm_at = now_secs();
            warmer.last_label = label.to_string();
            warmer.warm_count += 1;
            let mut out = json!({
                "ok": true,
                "label": label,
                "usage": {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "cache_hit_tokens": usage.cache_hit_tokens,
                    "cache_miss_tokens": usage.cache_miss_tokens,
                },
            });
            if let (Some(dst), Some(src)) = (
                out.as_object_mut(),
                warmer.status(rt.preheat_enabled, rt.preheat_ttl_seconds).as_object().cloned(),
            ) {
                for (k, v) in src {
                    dst.insert(k, v);
                }
            }
            out
        }
        Err(err) => {
            warmer.last_error = err.to_string();
            json!({ "error": warmer.last_error })
        }
    }
}

/// 后台预热（不阻塞调用方）：用于启动与新会话首轮
pub fn warm_background(state: AppState, system_prompt: String, tools: Vec<Value>, label: &'static str) {
    tokio::spawn(async move {
        let _ = warm(&state, &system_prompt, tools, false, label).await;
    });
}

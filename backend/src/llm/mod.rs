//! LLM 客户端（OpenAI 兼容端点）：流式对话、工具调用、用量与耗时统计。
//!
//! 与原 Python 版 `app/llm/client.py` 行为对齐：
//! - 流式解析 SSE：`content` 增量、`reasoning_content`（推理型模型）、`tool_calls` 分片聚合
//! - 统计 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（成本与缓存命中率的关键指标）
//! - 记录首字延迟（TTFT）、总耗时、tokens/s
//! - 网络错误/超时在"尚未输出任何内容"时重试（避免重复 token）

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_stream::try_stream;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: i64,
    pub timeout_s: u64,
    pub max_retries: u32,
    pub disable_thinking: bool,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:9000/v1".into(),
            api_key: "mock-key".into(),
            model: "mock".into(),
            max_tokens: 4096,
            timeout_s: 60,
            max_retries: 1,
            disable_thinking: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_hit_tokens: i64,
    pub cache_miss_tokens: i64,
    pub reasoning_tokens: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Timing {
    pub latency_ms: u64,
    pub ttft_ms: u64,
    pub completion_tokens: i64,
    pub reasoning_chars: usize,
    pub tokens_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn default_tool_type() -> String {
    "function".into()
}

/// 流式事件
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Text(String),
    Reasoning(String),
    ToolCalls(Vec<ToolCall>),
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("LLM HTTP {0}: {1}")]
    Http(u16, String),
    #[error("LLM 网络错误: {0}")]
    Network(String),
    #[error("LLM 响应解析失败: {0}")]
    Parse(String),
}

impl LlmError {
    pub fn retryable(&self) -> bool {
        match self {
            LlmError::Network(_) => true,
            LlmError::Http(code, _) => *code == 408 || *code == 429 || *code >= 500,
            LlmError::Parse(_) => false,
        }
    }
}

#[derive(Default)]
struct Aggregated {
    id: String,
    name: String,
    arguments: String,
}

pub struct LlmClient {
    http: reqwest::Client,
    cfg: LlmConfig,
    usage: Mutex<Usage>,
    timing: Mutex<Timing>,
}

impl LlmClient {
    pub fn new(cfg: LlmConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_s))
            // 不复用空闲连接：实测复用流式请求后的连接会导致下一次请求挂起至超时
            .pool_max_idle_per_host(0)
            .build()
            .unwrap_or_default();
        Self { http, cfg, usage: Mutex::new(Usage::default()), timing: Mutex::new(Timing::default()) }
    }

    #[allow(dead_code)]
    pub fn config(&self) -> &LlmConfig {
        &self.cfg
    }

    pub fn last_usage(&self) -> Usage {
        self.usage.lock().expect("usage lock").clone()
    }

    pub fn last_timing(&self) -> Timing {
        self.timing.lock().expect("timing lock").clone()
    }

    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.cfg.base_url.trim_end_matches('/'))
    }

    fn body(&self, messages: &[Value], tools: &[Value], stream: bool, max_tokens: Option<i64>) -> Value {
        let mut body = json!({
            "model": self.cfg.model,
            "messages": messages,
            "max_tokens": max_tokens.unwrap_or(self.cfg.max_tokens),
        });
        if stream {
            body["stream"] = json!(true);
            body["stream_options"] = json!({ "include_usage": true });
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
        }
        if self.cfg.disable_thinking {
            body["thinking"] = json!({ "type": "disabled" });
        }
        body
    }

    fn capture_usage(&self, chunk: &Value) {
        let usage = match chunk.get("usage").and_then(|u| u.as_object()) {
            Some(u) if !u.is_empty() => u,
            _ => return,
        };
        let get = |k: &str| usage.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        let reasoning = usage
            .get("completion_tokens_details")
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let mut guard = self.usage.lock().expect("usage lock");
        *guard = Usage {
            prompt_tokens: get("prompt_tokens"),
            completion_tokens: get("completion_tokens"),
            cache_hit_tokens: get("prompt_cache_hit_tokens"),
            cache_miss_tokens: get("prompt_cache_miss_tokens"),
            reasoning_tokens: reasoning,
        };
    }

    /// 发起请求并把非 2xx 转成可读错误（独立函数便于借用检查：错误分支直接 return）
    async fn open_stream(&self, body: &Value) -> Result<reqwest::Response, LlmError> {
        let resp = self
            .http
            .post(self.endpoint())
            .header("Authorization", format!("Bearer {}", self.cfg.api_key))
            .json(body)
            .send()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            return Err(LlmError::Http(status.as_u16(), detail.chars().take(500).collect()));
        }
        Ok(resp)
    }

    /// 流式对话：逐事件产出文本 / 推理内容 / 工具调用
    pub fn chat_stream(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
    ) -> impl Stream<Item = Result<StreamEvent, LlmError>> + '_ {
        try_stream! {
            let body = self.body(&messages, &tools, true, None);
            let started = Instant::now();
            let mut ttft_ms: Option<u64> = None;
            let mut reasoning_chars = 0usize;
            let mut emitted = false;
            let mut attempt: u32 = 0;

            loop {
                let resp = match self.open_stream(&body).await {
                    Ok(r) => r,
                    Err(err) => {
                        if !emitted && err.retryable() && attempt < self.cfg.max_retries {
                            attempt += 1;
                            tokio::time::sleep(Duration::from_millis(800 * attempt as u64)).await;
                            continue;
                        }
                        Err(err)?;
                        unreachable!();
                    }
                };

                let mut buf = String::new();
                let mut calls: BTreeMap<usize, Aggregated> = BTreeMap::new();
                let mut stream = resp.bytes_stream();
                let mut failed: Option<LlmError> = None;
                let mut finished = false;

                while let Some(chunk) = stream.next().await {
                    let bytes = match chunk {
                        Ok(b) => b,
                        Err(err) => {
                            failed = Some(LlmError::Network(err.to_string()));
                            break;
                        }
                    };
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(pos) = buf.find('\n') {
                        let line: String = buf.drain(..=pos).collect();
                        let line = line.trim();
                        let data = match line.strip_prefix("data:") {
                            Some(d) => d.trim(),
                            None => continue,
                        };
                        if data == "[DONE]" {
                            // 收到结束标记即停止读取并丢弃响应（避免服务端保持连接导致挂起）
                            finished = true;
                            break;
                        }
                        let chunk: Value = match serde_json::from_str(data) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if chunk.get("usage").is_some() {
                            self.capture_usage(&chunk);
                        }
                        let delta = chunk
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .cloned()
                            .unwrap_or(Value::Null);

                        if let Some(reasoning) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
                            if !reasoning.is_empty() {
                                if ttft_ms.is_none() {
                                    ttft_ms = Some(started.elapsed().as_millis() as u64);
                                }
                                reasoning_chars += reasoning.chars().count();
                                emitted = true;
                                yield StreamEvent::Reasoning(reasoning.to_string());
                            }
                        }
                        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                            if !content.is_empty() {
                                if ttft_ms.is_none() {
                                    ttft_ms = Some(started.elapsed().as_millis() as u64);
                                }
                                emitted = true;
                                yield StreamEvent::Text(content.to_string());
                            }
                        }
                        if let Some(list) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                            for tc in list {
                                emitted = true;
                                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                let slot = calls.entry(idx).or_default();
                                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                    if !id.is_empty() {
                                        slot.id = id.to_string();
                                    }
                                }
                                if let Some(f) = tc.get("function") {
                                    if let Some(name) = f.get("name").and_then(|v| v.as_str()) {
                                        if !name.is_empty() {
                                            slot.name = name.to_string();
                                        }
                                    }
                                    if let Some(args) = f.get("arguments").and_then(|v| v.as_str()) {
                                        slot.arguments.push_str(args);
                                    }
                                }
                            }
                        }
                    }
                    if finished {
                        break;
                    }
                }

                if let Some(err) = failed {
                    if emitted || attempt >= self.cfg.max_retries {
                        Err(err)?;
                    }
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(800 * attempt as u64)).await;
                    continue;
                }

                let latency_ms = started.elapsed().as_millis() as u64;
                let usage = self.last_usage();
                let completion = usage.completion_tokens;
                {
                    let mut t = self.timing.lock().expect("timing lock");
                    *t = Timing {
                        latency_ms,
                        ttft_ms: ttft_ms.unwrap_or(latency_ms),
                        completion_tokens: completion,
                        reasoning_chars,
                        tokens_per_sec: if latency_ms > 0 && completion > 0 {
                            (completion as f64) / (latency_ms as f64 / 1000.0)
                        } else {
                            0.0
                        },
                    };
                }

                if !calls.is_empty() {
                    let list: Vec<ToolCall> = calls
                        .into_values()
                        .map(|c| ToolCall {
                            id: c.id,
                            kind: "function".into(),
                            function: FunctionCall { name: c.name, arguments: c.arguments },
                        })
                        .collect();
                    yield StreamEvent::ToolCalls(list);
                }
                break;
            }
        }
    }

    /// 非流式对话（摘要/研判用），带可重试退避
    pub async fn chat(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
        max_tokens: Option<i64>,
    ) -> Result<Value, LlmError> {
        let body = self.body(&messages, &tools, false, max_tokens);
        let started = Instant::now();
        let mut attempt: u32 = 0;
        loop {
            match self.open_stream(&body).await {
                Ok(resp) => {
                    let data: Value = resp
                        .json()
                        .await
                        .map_err(|e| LlmError::Parse(e.to_string()))?;
                    if data.get("usage").is_some() {
                        self.capture_usage(&data);
                    }
                    let latency_ms = started.elapsed().as_millis() as u64;
                    {
                        let usage = self.last_usage();
                        let mut t = self.timing.lock().expect("timing lock");
                        *t = Timing {
                            latency_ms,
                            ttft_ms: latency_ms,
                            completion_tokens: usage.completion_tokens,
                            reasoning_chars: 0,
                            tokens_per_sec: if latency_ms > 0 && usage.completion_tokens > 0 {
                                (usage.completion_tokens as f64) / (latency_ms as f64 / 1000.0)
                            } else {
                                0.0
                            },
                        };
                    }
                    let message = data
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("message"))
                        .cloned()
                        .ok_or_else(|| LlmError::Parse(format!("无 choices：{}", data)))?;
                    return Ok(message);
                }
                Err(err) => {
                    let e = LlmError::Network(err.to_string());
                    if attempt < self.cfg.max_retries {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(800 * attempt as u64)).await;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    }
}

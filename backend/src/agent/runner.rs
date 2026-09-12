//! Agent 循环（流式）：模型 ↔ 工具，直到给出最终回答。
//!
//! 与原 Python 版 `app/agent/loop.py` 对齐的关键点：
//! - 每次调用前按阈值检查上下文压力，必要时压缩；压缩后重建 messages
//! - 工具结果超过 6000 字符时给出**合法 JSON** 的截断说明（而非把 JSON 截成半截）
//! - 工具消息成对性由 session::sanitize_tool_pairs 保证；工具序列类 400 时退化为无工具上下文重试一次
//! - 每次调用后回传 usage（缓存命中/未命中）与耗时（首字/TTFT/tokens per sec）

use std::time::Instant;

use async_stream::stream;
use futures_util::Stream;
use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::agent::events::AgentEvent;
use crate::agent::prompt::SYSTEM_PROMPT;
use crate::agent::session::{estimate_tokens, Msg, Session, SessionStore};
use crate::agent::tools::{build_registry_for, call_tool};
use crate::llm::{LlmClient, LlmConfig, StreamEvent};
use crate::state::AppState;

pub const MAX_STEPS: usize = 5;
pub const MAX_TOOL_RESULT_CHARS: usize = 6000;

fn client_for(state: &AppState, preset_model: Option<&str>, max_tokens: Option<i64>) -> LlmClient {
    let rt = state.rt();
    LlmClient::new(LlmConfig {
        base_url: rt.llm_base_url.clone(),
        api_key: rt.llm_api_key.clone(),
        model: preset_model.filter(|m| !m.is_empty()).unwrap_or(&rt.llm_model).to_string(),
        max_tokens: max_tokens.unwrap_or(rt.llm_max_tokens),
        timeout_s: 60,
        max_retries: 1,
        disable_thinking: rt.llm_disable_thinking,
    })
}

/// 工具结果序列化：超长时给出合法 JSON 的截断说明
fn dump_tool_result(result: &Value) -> String {
    let text = serde_json::to_string(result).unwrap_or_else(|_| "{}".into());
    if text.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return text;
    }
    let summary = summarize(result);
    let payload = json!({
        "truncated": true,
        "note": format!("结果过大（{} 字符）已截断；如需完整数据请缩小查询范围或分企业查询", text.chars().count()),
        "summary": summary,
    });
    let out = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
    out.chars().take(MAX_TOOL_RESULT_CHARS).collect()
}

/// 给前端展示用的工具结果摘要
pub fn summarize(result: &Value) -> Value {
    if let Some(err) = result.get("error") {
        return json!({ "ok": false, "error": err });
    }
    let mut out = serde_json::Map::new();
    out.insert("ok".into(), json!(true));
    for key in [
        "count", "score", "grade", "level", "summary", "enterprise_total",
        "avg_score", "enterprise_id", "enterprise_name",
    ] {
        if let Some(v) = result.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(ent) = result.get("enterprise") {
        if let Some(id) = ent.get("id") {
            out.insert("enterprise_id".into(), id.clone());
        }
        if let Some(name) = ent.get("name") {
            out.insert("enterprise_name".into(), name.clone());
        }
    }
    if let Some(list) = result.get("enterprises").and_then(|v| v.as_array()) {
        let brief: Vec<Value> = list
            .iter()
            .take(5)
            .map(|e| {
                json!({
                    "name": e.get("name"),
                    "score": e.get("score"),
                    "grade": e.get("grade"),
                    "level": e.get("level"),
                })
            })
            .collect();
        out.insert("enterprises".into(), json!(brief));
    }
    if let Some(dims) = result.get("dimensions").and_then(|v| v.as_object()) {
        let brief: serde_json::Map<String, Value> = dims
            .iter()
            .map(|(k, v)| {
                if v.is_object() {
                    (k.clone(), json!({ "score": v.get("score"), "label": v.get("label") }))
                } else {
                    // 刷新类结果：dimension → 文本摘要（如"新增 3/更新 5"）
                    (k.clone(), v.clone())
                }
            })
            .collect();
        out.insert("dimensions".into(), Value::Object(brief));
    }
    Value::Object(out)
}

fn build_messages(
    db: &crate::db::Db,
    data_dir: &std::path::Path,
    session: &Session,
    store: &SessionStore,
    system_prompt: &str,
    tool_free: bool,
) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
    messages.extend(store.context_with_media(db, data_dir, session, tool_free));
    messages
}

/// 图片按分辨率档位估算 token（提供方通常按 512×512 分块计费，这里取保守档）
pub fn media_tokens(atts: &[crate::services::attachments::Attachment]) -> i64 {
    atts.iter()
        .filter(|a| a.kind == "image")
        .map(|a| {
            let pixels = (a.width.max(0) as f64) * (a.height.max(0) as f64);
            if pixels <= 0.0 {
                800 // 尺寸未知：按常见截图估
            } else {
                ((pixels / (512.0 * 512.0)).ceil() as i64 * 170).clamp(170, 3200)
            }
        })
        .sum()
}

/// 运行一轮对话，产出 SSE 事件流
pub fn run_agent(
    state: AppState,
    mut session: Session,
    user_text: String,
    preset_id: Option<i64>,
    attachment_ids: Vec<String>,
) -> impl Stream<Item = AgentEvent> {
    stream! {
        let store = SessionStore::new();
        let db = state.db.clone();
        let data_dir = state.cfg.data_dir.clone();
        let rt = state.rt();

        // 载入 Agent 预设（提示词补充 + 工具白名单 + 技能白名单 + 模型覆盖）
        let preset = match crate::services::presets::get_preset(&db, preset_id) {
            Ok(p) => p,
            Err(err) => {
                yield AgentEvent::new("error", json!({ "message": format!("加载预设失败：{err}") }));
                return;
            }
        };
        let allowed_skills: Vec<String> = preset.as_ref().map(|p| p.skills.clone()).unwrap_or_default();
        let system_prompt = match &preset {
            Some(p) if !p.prompt_extra.is_empty() => {
                format!("{SYSTEM_PROMPT}\n\n[当前预设：{}]\n{}", p.name, p.prompt_extra)
            }
            _ => SYSTEM_PROMPT.to_string(),
        };

        let client = client_for(
            &state,
            preset.as_ref().map(|p| p.model_override.as_str()),
            None,
        );
        let reg = build_registry_for(&db, preset.as_ref());

        let user_msg = match store.append(&db, &mut session, Msg::new("user", user_text)) {
            Ok(m) => m,
            Err(err) => {
                yield AgentEvent::new("error", json!({ "message": format!("写入消息失败：{err}") }));
                return;
            }
        };
        // 附件挂到这条消息上（当期多模态；下一轮起自动降级为文本投影）
        let atts = if attachment_ids.is_empty() {
            Vec::new()
        } else {
            let _ = crate::services::attachments::bind_to_message(&db, &attachment_ids, &session.id, user_msg.id);
            crate::services::attachments::for_message(&db, user_msg.id).unwrap_or_default()
        };
        let media_extra = media_tokens(&atts);

        yield AgentEvent::new("session", json!({
            "session_id": session.id,
            "title": session.title,
            "attachment_count": atts.len(),
        }));
        if !atts.is_empty() {
            yield AgentEvent::new("attachment", json!({
                "message_id": user_msg.id,
                "items": atts.iter().map(|a| a.to_json()).collect::<Vec<_>>(),
                "media_tokens": media_extra,
            }));
        }

        let mut tool_free_retry = false;

        // 主动压缩检查（图片 token 单独计入）
        let messages = build_messages(&db, &data_dir, &session, &store, &system_prompt, false);
        let (over, est) = store.should_compact_extra(
            &session.messages,
            &reg.definitions(),
            media_extra,
            rt.llm_context_window,
            rt.compaction_threshold_ratio,
        );
        if rt.compaction_enabled && over {
            yield AgentEvent::new("compaction", json!({
                "phase": "start", "estimated_tokens": est,
                "window": rt.llm_context_window, "forced": false,
            }));
            match store.compact(
                &db, &mut session, &client, &messages, &reg.definitions(),
                rt.llm_context_window, rt.compaction_retain_ratio,
                rt.compaction_summary_max_tokens,
            ).await {
                Ok(Some(result)) => {
                    let _ = store.add_usage(&db, &session, &client.last_usage());
                    yield AgentEvent::new("compaction", json!({
                        "phase": "done", "folded": result.folded,
                        "summary_chars": result.summary.chars().count(),
                        "compact_count": session.compact_count,
                        "usage": store.usage_stats(&db, &session.id).unwrap_or_default(),
                    }));
                }
                _ => {
                    yield AgentEvent::new("compaction", json!({
                        "phase": "skipped", "reason": "无可折叠历史或摘要失败",
                    }));
                }
            }
        }

        for step in 0..MAX_STEPS {
            let messages = build_messages(&db, &data_dir, &session, &store, &system_prompt, tool_free_retry);
            let tools = reg.definitions();
            let mut text = String::new();
            let mut calls: Vec<crate::llm::ToolCall> = Vec::new();
            let mut stream_failed: Option<String> = None;

            {
                let mut s = Box::pin(client.chat_stream(messages, tools));
                while let Some(item) = s.next().await {
                    match item {
                        Ok(StreamEvent::Text(t)) => {
                            text.push_str(&t);
                            yield AgentEvent::new("token", json!({ "text": t }));
                        }
                        Ok(StreamEvent::Reasoning(r)) => {
                            yield AgentEvent::new("reasoning", json!({ "text": r }));
                        }
                        Ok(StreamEvent::ToolCalls(list)) => {
                            calls = list;
                        }
                        Err(err) => {
                            stream_failed = Some(err.to_string());
                            break;
                        }
                    }
                }
            }

            if let Some(err) = stream_failed {
                // 工具序列类 400：改用无工具上下文重试一次
                if !tool_free_retry && err.contains("400") &&
                    (err.contains("tool_calls") || err.contains("tool_call_id") || err.contains("'tool'"))
                {
                    tool_free_retry = true;
                    yield AgentEvent::new("compaction", json!({
                        "phase": "skipped", "reason": "工具消息序列异常，已改用精简上下文重试",
                    }));
                    continue;
                }
                yield AgentEvent::new("error", json!({ "message": format!("模型调用失败：{err}") }));
                return;
            }

            let usage = client.last_usage();
            let timing = client.last_timing();
            let stats = store.add_usage(&db, &session, &usage).unwrap_or_default();
            yield AgentEvent::new("usage", json!({
                "call": usage,
                "timing": timing,
                "llm_calls": stats.llm_calls,
                "prompt_tokens": stats.prompt_tokens,
                "completion_tokens": stats.completion_tokens,
                "cache_hit_tokens": stats.cache_hit_tokens,
                "cache_miss_tokens": stats.cache_miss_tokens,
                "cache_hit_rate": stats.cache_hit_rate,
                "compact_count": stats.compact_count,
            }));

            if calls.is_empty() {
                let _ = store.append(&db, &mut session, Msg::new("assistant", text));
                yield AgentEvent::new("done", json!({
                    "session_id": session.id,
                    "steps": step + 1,
                    "title": session.title,
                }));
                return;
            }

            let mut assistant = Msg::new("assistant", text);
            assistant.tool_calls = Some(calls.clone());
            let _ = store.append(&db, &mut session, assistant);

            for call in &calls {
                let name = call.function.name.clone();
                let args: Value = serde_json::from_str(&call.function.arguments)
                    .unwrap_or_else(|_| json!({}));
                let tool = reg.get(&name);
                let read_only = reg.is_read_only(&name);
                yield AgentEvent::new("tool", json!({
                    "id": call.id,
                    "name": name,
                    "args": args,
                    "read_only": read_only,
                }));

                // 写操作：先请求用户授权（Harness/Codex 的 approval 机制）
                if !read_only && rt.agent_require_approval {
                    let description = tool.map(|t| t.description.clone()).unwrap_or_default();
                    let slot = crate::agent::approvals::create(
                        &session.id, &call.id, &name, args.clone(), &description,
                    );
                    let approval_id = slot.lock().expect("approval lock").id.clone();
                    yield AgentEvent::new("approval", json!({
                        "approval_id": approval_id,
                        "id": call.id,
                        "name": name,
                        "args": args,
                        "description": description,
                        "timeout": rt.agent_approval_timeout,
                    }));
                    let approved = crate::agent::approvals::wait_for(&slot, rt.agent_approval_timeout).await;
                    crate::agent::approvals::discard(&approval_id);

                    if !approved {
                        let rejected = json!({
                            "error": format!("用户拒绝执行该操作（或等待授权超时 {}s）", rt.agent_approval_timeout)
                        });
                        let mut tool_msg = Msg::new("tool", dump_tool_result(&rejected));
                        tool_msg.tool_call_id = call.id.clone();
                        tool_msg.tool_name = name.clone();
                        let _ = store.append(&db, &mut session, tool_msg);
                        yield AgentEvent::new("tool_result", json!({
                            "id": call.id,
                            "name": name,
                            "result": { "ok": false, "error": rejected["error"] },
                            "latency_ms": 0,
                        }));
                        continue;
                    }
                }

                let started = Instant::now();
                let result = if crate::agent::tools::is_async_tool(&name) {
                    crate::agent::tools::call_tool_async(&state, &name, &args).await
                } else {
                    call_tool(&db, &name, &args, &allowed_skills)
                };
                let latency_ms = started.elapsed().as_millis() as u64;

                let mut tool_msg = Msg::new("tool", dump_tool_result(&result));
                tool_msg.tool_call_id = call.id.clone();
                tool_msg.tool_name = name.clone();
                let _ = store.append(&db, &mut session, tool_msg);

                yield AgentEvent::new("tool_result", json!({
                    "id": call.id,
                    "name": name,
                    "result": summarize(&result),
                    "latency_ms": latency_ms,
                }));
            }
        }

        yield AgentEvent::new("error", json!({
            "message": format!("达到最大工具调用轮次（{MAX_STEPS}），请换一种问法"),
        }));
    }
}

/// 供 /api/chat/usage 使用的上下文压力
pub fn context_pressure(state: &AppState, session: &Session) -> Value {
    let rt = state.rt();
    let reg = build_registry_for(&state.db, None);
    let est = estimate_tokens(&session.messages, &reg.definitions());
    json!({
        "estimated_tokens": est,
        "window": rt.llm_context_window,
        "ratio": if rt.llm_context_window > 0 {
            ((est as f64 / rt.llm_context_window as f64) * 1000.0).round() / 1000.0
        } else { 0.0 },
    })
}

//! 会话存储：持久化、上下文构建（含工具消息成对性修正）、上下文压缩、用量统计。
//!
//! 与 Python 版 `app/agent/session.py` 对齐，包含两个关键经验：
//! 1. `sanitize_tool_pairs`：窗口裁剪/会话中断后，保证 tool_calls 与 tool 结果成对（否则提供方 400）；
//! 2. 压缩时不得切断 assistant(tool_calls) 与其 tool 结果的配对。

use std::sync::Mutex;

use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Db;
use crate::llm::{LlmClient, ToolCall};

pub const WINDOW: usize = 12;
const MAX_TITLE_LEN: usize = 24;

pub const COMPACTION_INSTRUCTION: &str = "现在执行上下文压缩（compaction engine）：把上面的对话浓缩成一份可继续工作的简要纪要，\
只保留：用户目标、已确认的事实与数据（企业名/数字/预警编号）、未完成的待办。\
要求：不要提及本次摘要动作；不要调用任何工具；只输出纪要本身；不超过 400 字；用中文。";

#[derive(Debug, Clone, Serialize)]
pub struct Msg {
    pub id: i64,
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tool_name: String,
}

impl Msg {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            id: 0,
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: String::new(),
            tool_name: String::new(),
        }
    }

    /// 送入模型的消息（只保留协议字段）
    pub fn to_api(&self) -> Value {
        let mut v = json!({ "role": self.role, "content": self.content });
        if let Some(calls) = &self.tool_calls {
            if !calls.is_empty() {
                v["tool_calls"] = serde_json::to_value(calls).unwrap_or(json!([]));
            }
        }
        if !self.tool_call_id.is_empty() {
            v["tool_call_id"] = json!(self.tool_call_id);
        }
        v
    }
}

fn missing_tool_result(tool_call_id: &str) -> Msg {
    let mut m = Msg::new(
        "tool",
        json!({"error": "工具结果缺失（会话中断或已被裁剪），请重新调用该工具获取数据"}).to_string(),
    );
    m.tool_call_id = tool_call_id.to_string();
    m
}

/// 保证工具消息成对：孤立 tool 丢弃；缺失的 tool 结果补占位（避免提供方 400）
pub fn sanitize_tool_pairs(messages: Vec<Msg>) -> Vec<Msg> {
    let mut out: Vec<Msg> = Vec::with_capacity(messages.len());
    let mut pending: Vec<String> = Vec::new();

    fn flush(out: &mut Vec<Msg>, pending: &mut Vec<String>) {
        for id in pending.drain(..) {
            out.push(missing_tool_result(&id));
        }
    }

    for m in messages {
        if m.role == "tool" {
            if let Some(pos) = pending.iter().position(|x| *x == m.tool_call_id) {
                pending.remove(pos);
                out.push(m);
            }
            continue; // 孤立 tool → 丢弃
        }
        if m.role == "assistant" && m.tool_calls.as_ref().map(|c| !c.is_empty()).unwrap_or(false) {
            flush(&mut out, &mut pending);
            for call in m.tool_calls.as_ref().unwrap() {
                if !call.id.is_empty() {
                    pending.push(call.id.clone());
                }
            }
            out.push(m);
            continue;
        }
        flush(&mut out, &mut pending);
        out.push(m);
    }
    flush(&mut out, &mut pending);
    out
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionUsage {
    pub llm_calls: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_hit_tokens: i64,
    pub cache_miss_tokens: i64,
    pub cache_hit_rate: f64,
    pub compact_count: i64,
}

#[derive(Debug, Clone)]
pub struct Session {
    #[allow(dead_code)]
    pub created_at: String,
    pub id: String,
    pub title: String,
    pub messages: Vec<Msg>,
    pub summary: String,
    pub compacted_until: i64,
    pub compact_count: i64,
    pub updated_at: String,
}

/// 估算 token 数（中文约 1 字≈0.7 token，保守取字符/1.6）
pub fn estimate_tokens(messages: &[Msg], tools: &[Value]) -> i64 {
    let mut total: i64 = 0;
    for m in messages {
        total += (m.content.chars().count() as f64 / 1.6) as i64 + 6;
        if let Some(calls) = &m.tool_calls {
            let raw = serde_json::to_string(calls).unwrap_or_default();
            total += (raw.chars().count() as f64 / 2.5) as i64 + 4;
        }
    }
    for t in tools {
        let raw = serde_json::to_string(t).unwrap_or_default();
        total += (raw.chars().count() as f64 / 2.5) as i64 + 4;
    }
    total
}

#[derive(Debug, Clone, Serialize)]
pub struct CompactionResult {
    pub summary: String,
    pub until_id: i64,
    pub folded: usize,
    pub usage: Value,
}

pub struct SessionStore {
    lock: Mutex<()>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self { lock: Mutex::new(()) }
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, db: &Db, title: &str) -> Result<Session> {
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let now = chrono::Utc::now().to_rfc3339();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO chat_session (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params![id, title, now],
            )?;
            Ok(())
        })?;
        Ok(Session {
            id,
            title: title.to_string(),
            messages: vec![],
            summary: String::new(),
            compacted_until: 0,
            compact_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get(&self, db: &Db, session_id: &str) -> Result<Option<Session>> {
        db.with(|conn| {
            let row = conn.query_row(
                "SELECT id, title, summary, compacted_until, compact_count, created_at, updated_at
                 FROM chat_session WHERE id = ?1",
                [session_id],
                |r| {
                    Ok(Session {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        messages: vec![],
                        summary: r.get(2)?,
                        compacted_until: r.get(3)?,
                        compact_count: r.get(4)?,
                        created_at: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                },
            );
            let mut session = match row {
                Ok(s) => s,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            let mut stmt = conn.prepare(
                "SELECT id, role, content, tool_calls_json, tool_call_id, tool_name
                 FROM chat_message WHERE session_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map([session_id], |r| {
                let calls: String = r.get(3)?;
                Ok(Msg {
                    id: r.get(0)?,
                    role: r.get(1)?,
                    content: r.get(2)?,
                    tool_calls: if calls.is_empty() {
                        None
                    } else {
                        serde_json::from_str(&calls).ok()
                    },
                    tool_call_id: r.get(4)?,
                    tool_name: r.get(5)?,
                })
            })?;
            session.messages = rows.collect::<Result<Vec<_>, _>>()?;
            Ok(Some(session))
        })
    }

    pub fn get_or_create(&self, db: &Db, session_id: Option<&str>) -> Result<Session> {
        if let Some(id) = session_id {
            if let Some(s) = self.get(db, id)? {
                return Ok(s);
            }
        }
        self.create(db, "新对话")
    }

    /// 追加消息（落库并回填 id）
    pub fn append(&self, db: &Db, session: &mut Session, msg: Msg) -> Result<Msg> {
        let now = chrono::Utc::now().to_rfc3339();
        let calls_json = msg
            .tool_calls
            .as_ref()
            .filter(|c| !c.is_empty())
            .map(|c| serde_json::to_string(c).unwrap_or_default())
            .unwrap_or_default();
        let id = db.with(|conn| {
            conn.execute(
                "INSERT INTO chat_message
                 (session_id, role, content, tool_calls_json, tool_call_id, tool_name, ts)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                rusqlite::params![
                    session.id,
                    msg.role,
                    msg.content,
                    calls_json,
                    msg.tool_call_id,
                    msg.tool_name,
                    now
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })?;

        let mut stored = msg;
        stored.id = id;
        session.messages.push(stored.clone());
        session.updated_at = now.clone();

        // 会话标题：首条用户消息
        let need_title = session.title == "新对话" || session.title.is_empty();
        db.with(|conn| {
            conn.execute(
                "UPDATE chat_session SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, session.id],
            )?;
            if need_title && stored.role == "user" {
                let text = stored.content.trim().replace('\n', " ");
                if !text.is_empty() {
                    let title: String = text.chars().take(MAX_TITLE_LEN).collect();
                    let title = if text.chars().count() > MAX_TITLE_LEN { format!("{title}…") } else { title };
                    conn.execute(
                        "UPDATE chat_session SET title = ?1 WHERE id = ?2",
                        rusqlite::params![title, session.id],
                    )?;
                    session.title = title;
                }
            }
            Ok(())
        })?;
        Ok(stored)
    }

    /// 构建上下文：摘要（若有）+ 压缩点之后的最近 N 条（工具成对性已修正）
    pub fn context(&self, session: &Session, tool_free: bool) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        if !session.summary.is_empty() {
            out.push(json!({
                "role": "system",
                "content": format!("[会话摘要（更早的对话已压缩，视为已知信息）]\n{}", session.summary),
            }));
        }
        let recent: Vec<Msg> = session
            .messages
            .iter()
            .filter(|m| m.id > session.compacted_until)
            .cloned()
            .collect();

        let selected: Vec<Msg> = if tool_free {
            recent
                .into_iter()
                .filter(|m| {
                    m.role == "user"
                        || m.role == "system"
                        || (m.role == "assistant" && m.tool_calls.is_none())
                })
                .collect()
        } else {
            let start = recent.len().saturating_sub(WINDOW);
            sanitize_tool_pairs(recent[start..].to_vec())
        };

        for m in selected {
            out.push(m.to_api());
        }
        out
    }

    pub fn set_summary(&self, db: &Db, session: &mut Session, summary: &str, until_id: i64) -> Result<()> {
        session.summary = summary.to_string();
        session.compacted_until = until_id;
        session.compact_count += 1;
        let now = chrono::Utc::now().to_rfc3339();
        let (summary, until, count, id) =
            (summary.to_string(), until_id, session.compact_count, session.id.clone());
        db.with(|conn| {
            conn.execute(
                "UPDATE chat_session SET summary = ?1, compacted_until = ?2, compact_count = ?3, updated_at = ?4
                 WHERE id = ?5",
                rusqlite::params![summary, until, count, now, id],
            )?;
            Ok(())
        })
    }

    /// 累计用量（会话级）
    pub fn add_usage(&self, db: &Db, session: &Session, usage: &crate::llm::Usage) -> Result<SessionUsage> {
        db.with(|conn| {
            conn.execute(
                "UPDATE chat_session SET
                   llm_calls = llm_calls + 1,
                   prompt_tokens = prompt_tokens + ?1,
                   completion_tokens = completion_tokens + ?2,
                   cache_hit_tokens = cache_hit_tokens + ?3,
                   cache_miss_tokens = cache_miss_tokens + ?4
                 WHERE id = ?5",
                rusqlite::params![
                    usage.prompt_tokens,
                    usage.completion_tokens,
                    usage.cache_hit_tokens,
                    usage.cache_miss_tokens,
                    session.id
                ],
            )?;
            Ok(())
        })?;
        self.usage_stats(db, &session.id)
    }

    pub fn usage_stats(&self, db: &Db, session_id: &str) -> Result<SessionUsage> {
        db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT llm_calls, prompt_tokens, completion_tokens, cache_hit_tokens,
                        cache_miss_tokens, compact_count FROM chat_session WHERE id = ?1",
            )?;
            let row = stmt.query_row([session_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            });
            let (calls, prompt, completion, hit, miss, compact) = match row {
                Ok(v) => v,
                Err(rusqlite::Error::QueryReturnedNoRows) => (0, 0, 0, 0, 0, 0),
                Err(e) => return Err(e.into()),
            };
            let total = hit + miss;
            Ok(SessionUsage {
                llm_calls: calls,
                prompt_tokens: prompt,
                completion_tokens: completion,
                cache_hit_tokens: hit,
                cache_miss_tokens: miss,
                cache_hit_rate: if total > 0 {
                    ((hit as f64 / total as f64) * 10000.0).round() / 10000.0
                } else {
                    0.0
                },
                compact_count: compact,
            })
        })
    }

    /// 会话列表（置顶优先 + 标题/内容检索）
    pub fn list_sessions(&self, db: &Db, limit: i64, q: &str) -> Result<Vec<Value>> {
        db.with(|conn| {
            let like = format!("%{q}%");
            let sql = if q.trim().is_empty() {
                "SELECT id, title, pinned, created_at, updated_at, share_token,
                        (SELECT COUNT(*) FROM chat_message m WHERE m.session_id = s.id)
                 FROM chat_session s ORDER BY pinned DESC, updated_at DESC LIMIT ?1"
            } else {
                "SELECT id, title, pinned, created_at, updated_at, share_token,
                        (SELECT COUNT(*) FROM chat_message m WHERE m.session_id = s.id)
                 FROM chat_session s
                 WHERE title LIKE ?2
                    OR EXISTS (SELECT 1 FROM chat_message m WHERE m.session_id = s.id AND m.content LIKE ?2)
                 ORDER BY pinned DESC, updated_at DESC LIMIT ?1"
            };
            let mut stmt = conn.prepare(sql)?;
            let map_row = |r: &rusqlite::Row<'_>| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "pinned": r.get::<_, i64>(2)? != 0,
                    "created_at": r.get::<_, String>(3)?,
                    "updated_at": r.get::<_, String>(4)?,
                    "shared": !r.get::<_, String>(5)?.is_empty(),
                    "message_count": r.get::<_, i64>(6)?,
                }))
            };
            let rows = if q.trim().is_empty() {
                stmt.query_map([limit], map_row)?.collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(rusqlite::params![limit, like], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let _ = &self.lock;
            Ok(rows)
        })
    }

    pub fn rename(&self, db: &Db, session_id: &str, title: &str) -> Result<Value> {
        let now = chrono::Utc::now().to_rfc3339();
        let title = title.trim().chars().take(120).collect::<String>();
        db.with(|conn| {
            let n = conn.execute(
                "UPDATE chat_session SET title = CASE WHEN ?1 = '' THEN title ELSE ?1 END, updated_at = ?2
                 WHERE id = ?3",
                rusqlite::params![title, now, session_id],
            )?;
            Ok(n)
        })?;
        Ok(json!({ "ok": true, "id": session_id }))
    }

    pub fn set_pinned(&self, db: &Db, session_id: &str, pinned: bool) -> Result<Value> {
        db.with(|conn| {
            conn.execute(
                "UPDATE chat_session SET pinned = ?1 WHERE id = ?2",
                rusqlite::params![if pinned { 1 } else { 0 }, session_id],
            )?;
            Ok(())
        })?;
        Ok(json!({ "ok": true, "id": session_id, "pinned": pinned }))
    }

    pub fn delete(&self, db: &Db, session_id: &str) -> Result<bool> {
        let n = db.with(|conn| {
            conn.execute("DELETE FROM chat_message WHERE session_id = ?1", [session_id])?;
            Ok(conn.execute("DELETE FROM chat_session WHERE id = ?1", [session_id])?)
        })?;
        Ok(n > 0)
    }

    pub fn clear_messages(&self, db: &Db, session_id: &str) -> Result<i64> {
        db.with(|conn| {
            let n = conn.execute("DELETE FROM chat_message WHERE session_id = ?1", [session_id])?;
            conn.execute(
                "UPDATE chat_session SET summary = '', compacted_until = 0, compact_count = 0 WHERE id = ?1",
                [session_id],
            )?;
            Ok(n as i64)
        })
    }

    pub fn batch_delete(&self, db: &Db, ids: &[String]) -> Result<i64> {
        let mut deleted = 0;
        for id in ids {
            if self.delete(db, id)? {
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    // ---------------- 上下文压缩 ----------------

    pub fn should_compact(&self, messages: &[Msg], tools: &[Value], window: i64, threshold: f64) -> (bool, i64) {
        let est = estimate_tokens(messages, tools);
        (est as f64 >= window as f64 * threshold, est)
    }

    /// 按 retain 比例切分：返回 (待折叠消息, 折叠到的最后一条 id)
    pub fn split_for_compaction(&self, session: &Session, window: i64, retain: f64) -> (Vec<Msg>, i64) {
        let active: Vec<Msg> = session
            .messages
            .iter()
            .filter(|m| m.id > session.compacted_until)
            .cloned()
            .collect();
        if active.len() <= 2 {
            return (vec![], 0);
        }
        let budget = (window as f64 * retain) as i64;
        let mut kept: Vec<Msg> = Vec::new();
        let mut used: i64 = 0;
        for m in active.iter().rev() {
            used += estimate_tokens(std::slice::from_ref(m), &[]);
            if used > budget && !kept.is_empty() {
                break;
            }
            kept.insert(0, m.clone());
        }
        let cut = active.len().saturating_sub(kept.len());
        if cut == 0 {
            return (vec![], 0);
        }
        let mut fold: Vec<Msg> = active[..cut].to_vec();
        // 不切断 assistant(tool_calls) 与其 tool 结果
        while fold
            .last()
            .map(|m| m.role == "assistant" && m.tool_calls.is_some())
            .unwrap_or(false)
        {
            fold.pop();
        }
        if fold.is_empty() {
            return (vec![], 0);
        }
        let until_id = fold.last().map(|m| m.id).unwrap_or(0);
        (fold, until_id)
    }

    /// 执行压缩：复用当前请求前缀 + 末尾追加压缩指令（保护前缀缓存）
    pub async fn compact(
        &self,
        db: &Db,
        session: &mut Session,
        client: &LlmClient,
        base_messages: &[Value],
        tools: &[Value],
        window: i64,
        retain: f64,
        summary_max_tokens: i64,
    ) -> Result<Option<CompactionResult>> {
        let (fold, until_id) = self.split_for_compaction(session, window, retain);
        if fold.is_empty() || until_id == 0 {
            return Ok(None);
        }
        let mut messages = base_messages.to_vec();
        messages.push(json!({ "role": "user", "content": COMPACTION_INSTRUCTION }));

        let reply = match client
            .chat(messages, tools.to_vec(), Some(summary_max_tokens))
            .await
        {
            Ok(v) => v,
            Err(err) => {
                eprintln!("[compaction] 摘要失败：{err}");
                return Ok(None);
            }
        };
        let summary = reply
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if summary.is_empty() {
            return Ok(None);
        }
        self.set_summary(db, session, &summary, until_id)?;
        Ok(Some(CompactionResult {
            summary,
            until_id,
            folded: fold.len(),
            usage: serde_json::to_value(client.last_usage()).unwrap_or(json!({})),
        }))
    }
}

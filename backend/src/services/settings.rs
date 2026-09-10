//! 运行时设置：DB 覆盖 + 前端展示元数据（对齐 Python 版 `app/services/settings_store.py`）。
//!
//! - 默认值来自 `RuntimeCfg`（环境变量 / CLI）
//! - 用户在设置面板修改后写入 `app_setting` 表，并立即覆盖内存中的运行时配置（无需重启）
//! - 敏感字段（API Key）只回显掩码，不回传明文

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::config::RuntimeCfg;
use crate::db::Db;
use crate::util::now_db;

pub const MASK_CHAR: char = '•';

/// 可编辑字段元数据：分组 → [字段]（键名与 Python 版一一对应）
const FIELDS: [(&str, &[(&str, &str, &str, &str)]); 3] = [
    (
        "模型服务",
        &[
            ("llm_base_url", "API 地址", "text", "OpenAI 兼容端点；选择提供商后自动填入"),
            ("llm_api_key", "API Key", "password", "仅保存在本地，不会回传明文"),
            ("llm_model", "模型名称", "text", "点击「获取可用模型」后从列表选择"),
            ("llm_max_tokens", "单次输出上限", "int", "普通对话的 max_tokens"),
            ("llm_analysis_max_tokens", "研判输出上限", "int", "风险研判（需输出完整 JSON）的 max_tokens"),
            (
                "llm_disable_thinking",
                "关闭模型思考",
                "bool",
                "推理型模型（如 deepseek-v4-flash-vision-exp）会先输出思考内容，关闭后响应更快，但复杂分析质量可能下降",
            ),
        ],
    ),
    (
        "上下文与压缩",
        &[
            ("llm_context_window", "上下文窗口", "int", "模型窗口 token 数，压缩阈值按它缩放"),
            ("compaction_enabled", "启用自动压缩", "bool", "上下文接近上限时把历史折叠为摘要"),
            ("compaction_threshold_ratio", "压缩触发比例", "float", "用量 ≥ 窗口 × 该比例时触发（DSH 默认 0.8）"),
            ("compaction_retain_ratio", "压缩保留比例", "float", "压缩后保留最近的比例（DSH 默认 0.16）"),
            ("compaction_summary_max_tokens", "摘要输出上限", "int", "生成摘要的 max_tokens"),
        ],
    ),
    (
        "动作审批",
        &[
            ("agent_require_approval", "动作工具需授权", "bool", "写操作（刷新数据/研判/处置预警）执行前需用户确认"),
            ("agent_approval_timeout", "授权超时(秒)", "int", "超时视为拒绝"),
        ],
    ),
];

/// 提供商预设（快速部署：选提供商 → 填 Key → 拉取模型）
pub fn providers() -> Value {
    json!([
        { "id": "deepseek", "label": "DeepSeek", "base_url": "https://api.deepseek.com/v1",
          "default_model": "deepseek-v4-flash-vision-exp", "key_hint": "sk-...", "note": "推荐：多模态 + 高缓存命中" },
        { "id": "openai", "label": "OpenAI", "base_url": "https://api.openai.com/v1",
          "default_model": "gpt-4o-mini", "key_hint": "sk-..." },
        { "id": "dashscope", "label": "阿里云百炼（通义千问）", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "default_model": "qwen-plus", "key_hint": "sk-..." },
        { "id": "zhipu", "label": "智谱 GLM", "base_url": "https://open.bigmodel.cn/api/paas/v4",
          "default_model": "glm-4-plus", "key_hint": "..." },
        { "id": "moonshot", "label": "月之暗面 Kimi", "base_url": "https://api.moonshot.cn/v1",
          "default_model": "moonshot-v1-8k", "key_hint": "sk-..." },
        { "id": "siliconflow", "label": "硅基流动 SiliconFlow", "base_url": "https://api.siliconflow.cn/v1",
          "default_model": "deepseek-ai/DeepSeek-V3", "key_hint": "sk-..." },
        { "id": "ollama", "label": "本地 Ollama", "base_url": "http://127.0.0.1:11434/v1",
          "default_model": "qwen2.5:7b", "key_hint": "可留空", "key_optional": true },
        { "id": "custom", "label": "其他（自定义 OpenAI 兼容端点）", "base_url": "",
          "default_model": "", "key_hint": "按需填写" },
    ])
}

fn mask(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = value.chars().collect();
    if chars.len() > 12 {
        let head: String = chars[..6].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}{}{tail}", MASK_CHAR.to_string().repeat(6))
    } else {
        MASK_CHAR.to_string().repeat(8)
    }
}

/// 读取字段值（按 FIELDS 中的键）
fn get_field(rt: &RuntimeCfg, key: &str) -> Value {
    match key {
        "llm_base_url" => json!(rt.llm_base_url),
        "llm_api_key" => json!(rt.llm_api_key),
        "llm_model" => json!(rt.llm_model),
        "llm_max_tokens" => json!(rt.llm_max_tokens),
        "llm_analysis_max_tokens" => json!(rt.llm_analysis_max_tokens),
        "llm_disable_thinking" => json!(rt.llm_disable_thinking),
        "llm_context_window" => json!(rt.llm_context_window),
        "compaction_enabled" => json!(rt.compaction_enabled),
        "compaction_threshold_ratio" => json!(rt.compaction_threshold_ratio),
        "compaction_retain_ratio" => json!(rt.compaction_retain_ratio),
        "compaction_summary_max_tokens" => json!(rt.compaction_summary_max_tokens),
        "agent_require_approval" => json!(rt.agent_require_approval),
        "agent_approval_timeout" => json!(rt.agent_approval_timeout),
        "preheat_enabled" => json!(rt.preheat_enabled),
        "preheat_on_startup" => json!(rt.preheat_on_startup),
        "preheat_ttl_seconds" => json!(rt.preheat_ttl_seconds),
        _ => Value::Null,
    }
}

/// 写入字段值（返回是否识别该键）
fn set_field(rt: &mut RuntimeCfg, key: &str, value: &Value) -> bool {
    macro_rules! set_str {
        ($field:ident) => {
            if let Some(v) = value.as_str() {
                rt.$field = v.to_string();
                return true;
            }
        };
    }
    macro_rules! set_i64 {
        ($field:ident) => {
            if let Some(v) = value.as_i64().or_else(|| value.as_str().and_then(|s| s.parse().ok())) {
                // 字段可能是 i64/u64：统一取非负后按目标类型转换
                rt.$field = v.max(0) as _;
                return true;
            }
        };
    }
    macro_rules! set_f64 {
        ($field:ident) => {
            if let Some(v) = value
                .as_f64()
                .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            {
                rt.$field = v;
                return true;
            }
        };
    }
    macro_rules! set_bool {
        ($field:ident) => {
            if let Some(v) = value.as_bool().or_else(|| {
                value.as_str().map(|s| matches!(s.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            }) {
                rt.$field = v;
                return true;
            }
        };
    }
    match key {
        "llm_base_url" => set_str!(llm_base_url),
        "llm_api_key" => set_str!(llm_api_key),
        "llm_model" => set_str!(llm_model),
        "llm_max_tokens" => set_i64!(llm_max_tokens),
        "llm_analysis_max_tokens" => set_i64!(llm_analysis_max_tokens),
        "llm_disable_thinking" => set_bool!(llm_disable_thinking),
        "llm_context_window" => set_i64!(llm_context_window),
        "compaction_enabled" => set_bool!(compaction_enabled),
        "compaction_threshold_ratio" => set_f64!(compaction_threshold_ratio),
        "compaction_retain_ratio" => set_f64!(compaction_retain_ratio),
        "compaction_summary_max_tokens" => set_i64!(compaction_summary_max_tokens),
        "agent_require_approval" => set_bool!(agent_require_approval),
        "agent_approval_timeout" => set_i64!(agent_approval_timeout),
        "preheat_enabled" => set_bool!(preheat_enabled),
        "preheat_on_startup" => set_bool!(preheat_on_startup),
        "preheat_ttl_seconds" => set_i64!(preheat_ttl_seconds),
        _ => return false,
    }
    true
}

/// 设置面板视图（api 密钥掩码）
pub fn get_view(rt: &RuntimeCfg) -> Value {
    let mut groups = Vec::new();
    for (group, fields) in FIELDS.iter() {
        let mut items = Vec::new();
        for (key, label, kind, desc) in fields.iter() {
            let raw = get_field(rt, key);
            let mut item = json!({
                "key": key, "label": label, "type": kind, "desc": desc,
            });
            if *kind == "password" {
                let text = raw.as_str().unwrap_or("");
                item["value"] = json!(mask(text));
                item["has_value"] = json!(!text.is_empty());
            } else {
                item["value"] = raw;
            }
            items.push(item);
        }
        groups.push(json!({ "group": group, "items": items }));
    }
    json!({
        "groups": groups,
        "providers": providers(),
        "runtime": {
            "model": rt.llm_model,
            "base_url": rt.llm_base_url,
            "context_window": rt.llm_context_window,
            "compaction_enabled": rt.compaction_enabled,
            "require_approval": rt.agent_require_approval,
            "has_api_key": !rt.llm_api_key.is_empty(),
        },
    })
}

/// 拉取提供商可用模型列表（OpenAI 兼容 /models）
pub async fn list_models(base_url: &str, api_key: &str, rt: &RuntimeCfg) -> Value {
    let mut url = base_url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return json!({ "error": "请先选择提供商或填写 API 地址", "models": [] });
    }
    if !url.ends_with("/v1") && !url.contains("/v1") {
        url.push_str("/v1");
    }
    // 前端传回的是掩码或空值时，回退到已保存的 Key
    let key = if api_key.trim().is_empty() || api_key.contains(MASK_CHAR) {
        rt.llm_api_key.trim().to_string()
    } else {
        api_key.trim().to_string()
    };
    let mut req = crate::datasources::http::client().get(format!("{url}/models"));
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(err) => return json!({ "error": format!("{err}"), "models": [] }),
    };
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return json!({
            "error": format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()),
            "models": [],
        });
    }
    let data: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(err) => return json!({ "error": format!("响应解析失败: {err}"), "models": [] }),
    };
    let items = data
        .get("data")
        .or_else(|| data.get("models"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut models: Vec<String> = Vec::new();
    for m in items {
        let id = if let Some(obj) = m.as_object() {
            obj.get("id")
                .or_else(|| obj.get("name"))
                .or_else(|| obj.get("model"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        } else {
            m.as_str().map(|s| s.to_string())
        };
        if let Some(id) = id {
            if !id.is_empty() {
                models.push(id);
            }
        }
    }
    models.sort();
    models.dedup();
    json!({ "models": models, "count": models.len() })
}

/// 保存并立即生效。payload: {field_key: value}
pub fn update(db: &Db, rt: &mut RuntimeCfg, payload: &Value) -> Result<(Value, Vec<String>)> {
    let mut applied = serde_json::Map::new();
    let mut errors: Vec<String> = Vec::new();

    for (_, fields) in FIELDS.iter() {
        for (key, label, kind, _) in fields.iter() {
            let Some(value) = payload.get(*key) else {
                continue;
            };
            let mut value = value.clone();
            if *kind == "password" {
                let text = value.as_str().unwrap_or("");
                if text.is_empty() || text.contains(MASK_CHAR) {
                    continue; // 未修改
                }
                value = json!(text.trim());
            }
            // 类型转换失败 → 记错误并跳过（与 Python 版一致）
            let coerced = match *kind {
                "int" => value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
                    .map(|v| json!(v)),
                "float" => value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
                    .map(|v| json!(v)),
                "bool" => Some(json!(value
                    .as_bool()
                    .unwrap_or_else(|| matches!(
                        value.as_str().unwrap_or("").to_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )))),
                _ => Some(value.clone()),
            };
            let Some(coerced) = coerced else {
                errors.push(format!("{label}: 值类型不正确"));
                continue;
            };
            if !set_field(rt, key, &coerced) {
                errors.push(format!("{label}: 未知设置项"));
                continue;
            }
            db.with(|conn| {
                conn.execute(
                    "INSERT INTO app_setting (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    params![key, serde_json::to_string(&coerced).unwrap_or_default(), now_db()],
                )?;
                Ok(())
            })?;
            applied.insert(key.to_string(), coerced);
        }
    }

    Ok((Value::Object(applied), errors))
}

/// 启动时把 DB 中的覆盖值应用回运行时配置
pub fn load_and_apply(db: &Db, rt: &mut RuntimeCfg) -> Result<Vec<String>> {
    let rows = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT key, value FROM app_setting")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut applied = Vec::new();
    for (key, raw) in rows {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if set_field(rt, &key, &value) {
                applied.push(key);
            }
        }
    }
    Ok(applied)
}

/// 清除所有覆盖，回到 .env / 默认值
pub fn reset(db: &Db) -> Result<Value> {
    db.with(|conn| {
        conn.execute("DELETE FROM app_setting", [])?;
        Ok(())
    })?;
    Ok(json!({ "reset": true, "note": "已清除覆盖值，重启后端后完全恢复默认配置" }))
}

/// 是否存在某个键的覆盖记录（诊断用）
#[allow(dead_code)]
pub fn has_override(db: &Db, key: &str) -> Result<bool> {
    let row: Option<String> = db.with(|conn| {
        Ok(conn
            .query_row("SELECT value FROM app_setting WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    })?;
    Ok(row.is_some())
}

//! 用户手搓插件（声明式 HTTP 工具）与 Agent 预设 + 分享包导入导出。
//!
//! 对齐 DSH 的设计理念：
//! - **插件**：声明 name / description / parameters(JSON Schema) + HTTP 调用模板
//!   （URL/Headers/Body 支持 `{arg}` 占位），不写代码即可接入任意 REST 接口；
//! - **预设**：把"提示词补充 + 工具白名单 + 技能白名单 + 模型覆盖"组合成一个 Agent 人格，
//!   会话可选预设（相当于 DSH 的 cordis.yml 组合，这里用界面/数据库表达）。

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::db::Db;
use crate::util::now_db;

pub const BUNDLE_KIND: &str = "risk-warning-agent-bundle";
pub const BUNDLE_VERSION: i64 = 1;

/// 内置预设（工具/技能白名单为空 = 全部可用）
const BUILTIN_PRESETS: [(&str, &str, &str, &[&str], &[&str]); 4] = [
    (
        "通用风险分析师",
        "默认预设：全工具、全技能，平衡型风险分析",
        "你以稳健、克制的方式分析风险，结论先行，证据必附来源。",
        &[],
        &[],
    ),
    (
        "合规审查专员",
        "聚焦法律合规与信用维度，只读工具为主，输出合规风险清单",
        "你专注合规视角：优先关注司法、行政、失信与监管问询信号；对每个结论标注法规/监管依据来源；不给出投资建议。",
        &[
            "search_enterprise",
            "get_score_profile",
            "get_risk_facts",
            "list_skills",
            "load_skill",
            "get_alert_report",
        ],
        &["企业风险评估报告", "预警处置建议"],
    ),
    (
        "投资尽调助手",
        "面向投前尽调：财务+经营+舆情并重，输出要点与风险提示",
        "你服务投前尽调：先给结论与关键指标，再给风险清单与需补充材料清单；明确区分「事实」与「推断」。",
        &[
            "search_enterprise",
            "get_score_profile",
            "get_risk_facts",
            "list_enterprises_by_level",
            "get_platform_overview",
            "list_skills",
            "load_skill",
        ],
        &["企业风险评估报告", "多企业对比分析", "舆情专项研判"],
    ),
    (
        "财务分析师",
        "聚焦财报：杜邦分解 + Z/F/M 模型 + 同业对标 + 异常勾稽，输出财务分析结论",
        "你是财务分析师：所有数字必须来自工具返回的财报指标，并标注年份与单位；模型结论要写明阈值与输入完整度（可计算/近似/缺失），缺失即说明缺失，不得推测；对异常信号要给出可能原因与需进一步核实的材料清单；不构成投资建议。",
        &[
            "search_enterprise",
            "get_financial_analysis",
            "compare_financials",
            "screen_by_financial_metric",
            "get_score_profile",
            "get_risk_facts",
            "refresh_enterprise_data",
            "list_skills",
            "load_skill",
        ],
        &["财务分析", "多企业对比分析", "企业风险评估报告"],
    ),
];

#[derive(Debug, Clone)]
pub struct Preset {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub prompt_extra: String,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
    pub model_override: String,
    pub enabled: bool,
    pub builtin: bool,
}

impl Preset {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "prompt_extra": self.prompt_extra,
            "tools": self.tools,
            "skills": self.skills,
            "model_override": self.model_override,
            "enabled": self.enabled,
            "builtin": self.builtin,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CustomTool {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub method: String,
    pub url: String,
    pub headers: Value,
    pub body_template: String,
    pub enabled: bool,
    pub require_approval: bool,
    pub builtin: bool,
}

fn parse_names(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn map_preset(r: &rusqlite::Row<'_>) -> rusqlite::Result<Preset> {
    Ok(Preset {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        prompt_extra: r.get(3)?,
        tools: parse_names(&r.get::<_, String>(4)?),
        skills: parse_names(&r.get::<_, String>(5)?),
        model_override: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        builtin: r.get::<_, i64>(8)? != 0,
    })
}

const PRESET_COLS: &str =
    "id, name, description, prompt_extra, tools_json, skills_json, model_override, enabled, builtin";

// ---------------------------------------------------------------------------
// Agent 预设
// ---------------------------------------------------------------------------

/// 读取启用中的预设（供 Agent 循环使用）
pub fn get_preset(db: &Db, preset_id: Option<i64>) -> Result<Option<Preset>> {
    let Some(id) = preset_id.filter(|v| *v > 0) else {
        return Ok(None);
    };
    db.with(|conn| {
        let row = conn
            .query_row(
                &format!("SELECT {PRESET_COLS} FROM agent_preset WHERE id = ?1"),
                [id],
                map_preset,
            )
            .optional()?;
        Ok(row.filter(|p| p.enabled))
    })
}

pub fn list_presets(db: &Db) -> Result<Value> {
    let items = db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {PRESET_COLS} FROM agent_preset ORDER BY builtin DESC, id"
        ))?;
        let rows = stmt
            .query_map([], |r| map_preset(r).map(|p| p.to_json()))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": items.len(), "items": items }))
}

pub fn create_preset(db: &Db, body: &Value) -> Result<Value> {
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Ok(json!({ "error": "预设名称不能为空" }));
    }
    let now = now_db();
    db.with(|conn| {
        let exists: Option<i64> = conn
            .query_row("SELECT id FROM agent_preset WHERE name = ?1", [&name], |r| r.get(0))
            .optional()?;
        if exists.is_some() {
            return Ok(json!({ "error": format!("预设已存在：{name}") }));
        }
        let tools: Vec<String> = body
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let skills: Vec<String> = body
            .get("skills")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        conn.execute(
            "INSERT INTO agent_preset
               (name, description, prompt_extra, tools_json, skills_json, model_override, enabled, builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
            params![
                name,
                body.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                body.get("prompt_extra").and_then(|v| v.as_str()).unwrap_or(""),
                serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&skills).unwrap_or_else(|_| "[]".into()),
                body.get("model_override").and_then(|v| v.as_str()).unwrap_or(""),
                if body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                now,
            ],
        )?;
        Ok(json!({ "preset_id": conn.last_insert_rowid(), "name": name }))
    })
}

pub fn update_preset(db: &Db, preset_id: i64, body: &Value) -> Result<Value> {
    let exists: Option<i64> = db.with(|conn| {
        Ok(conn
            .query_row("SELECT id FROM agent_preset WHERE id = ?1", [preset_id], |r| r.get(0))
            .optional()?)
    })?;
    if exists.is_none() {
        return Ok(json!({ "error": format!("预设不存在: {preset_id}") }));
    }
    db.with(|conn| {
        for key in ["name", "description", "prompt_extra", "model_override"] {
            if let Some(v) = body.get(key).and_then(|v| v.as_str()) {
                conn.execute(
                    &format!("UPDATE agent_preset SET {key} = ?1 WHERE id = ?2"),
                    params![v, preset_id],
                )?;
            }
        }
        for (key, col) in [("tools", "tools_json"), ("skills", "skills_json")] {
            if let Some(arr) = body.get(key).and_then(|v| v.as_array()) {
                let list: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect();
                conn.execute(
                    &format!("UPDATE agent_preset SET {col} = ?1 WHERE id = ?2"),
                    params![serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()), preset_id],
                )?;
            }
        }
        if let Some(v) = body.get("enabled").and_then(|v| v.as_bool()) {
            conn.execute(
                "UPDATE agent_preset SET enabled = ?1 WHERE id = ?2",
                params![v as i64, preset_id],
            )?;
        }
        conn.execute(
            "UPDATE agent_preset SET updated_at = ?1 WHERE id = ?2",
            params![now_db(), preset_id],
        )?;
        Ok(json!({ "ok": true, "preset_id": preset_id }))
    })
}

pub fn delete_preset(db: &Db, preset_id: i64) -> Result<Value> {
    db.with(|conn| {
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT name, builtin FROM agent_preset WHERE id = ?1",
                [preset_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let (name, builtin) = match row {
            Some(v) => v,
            None => return Ok(json!({ "error": format!("预设不存在: {preset_id}") })),
        };
        if builtin != 0 {
            return Ok(json!({ "error": "内置预设不可删除，可停用或另存为新预设" }));
        }
        conn.execute("DELETE FROM agent_preset WHERE id = ?1", [preset_id])?;
        Ok(json!({ "deleted": preset_id, "name": name }))
    })
}

pub fn seed_builtin_presets(db: &Db) -> Result<i64> {
    let now = now_db();
    db.with(|conn| {
        let mut created = 0i64;
        for (name, description, prompt_extra, tools, skills) in BUILTIN_PRESETS.iter() {
            let exists: Option<i64> = conn
                .query_row("SELECT id FROM agent_preset WHERE name = ?1", [name], |r| r.get(0))
                .optional()?;
            if exists.is_some() {
                continue;
            }
            conn.execute(
                "INSERT INTO agent_preset
                   (name, description, prompt_extra, tools_json, skills_json, model_override, enabled, builtin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, '', 1, 1, ?6, ?6)",
                params![
                    name,
                    description,
                    prompt_extra,
                    serde_json::to_string(tools).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(skills).unwrap_or_else(|_| "[]".into()),
                    now,
                ],
            )?;
            created += 1;
        }
        Ok(created)
    })
}

// ---------------------------------------------------------------------------
// 插件（自定义工具）
// ---------------------------------------------------------------------------

fn map_custom_tool(r: &rusqlite::Row<'_>) -> rusqlite::Result<CustomTool> {
    let parameters: String = r.get(3)?;
    let headers: String = r.get(6)?;
    Ok(CustomTool {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        parameters: serde_json::from_str(&parameters).unwrap_or_else(|_| json!({})),
        method: r.get(4)?,
        url: r.get(5)?,
        headers: serde_json::from_str(&headers).unwrap_or_else(|_| json!({})),
        body_template: r.get(7)?,
        enabled: r.get::<_, i64>(8)? != 0,
        require_approval: r.get::<_, i64>(9)? != 0,
        builtin: r.get::<_, i64>(10)? != 0,
    })
}

const TOOL_COLS: &str = "id, name, description, parameters_json, method, url, headers_json, body_template, enabled, require_approval, builtin";

impl CustomTool {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "method": self.method,
            "url": self.url,
            "headers": self.headers,
            "body_template": self.body_template,
            "enabled": self.enabled,
            "require_approval": self.require_approval,
            "builtin": self.builtin,
        })
    }
}

pub fn list_custom_tools(db: &Db) -> Result<Value> {
    let items = db.with(|conn| {
        let mut stmt =
            conn.prepare(&format!("SELECT {TOOL_COLS} FROM custom_tool ORDER BY id"))?;
        let rows = stmt
            .query_map([], |r| map_custom_tool(r).map(|t| t.to_json()))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": items.len(), "items": items }))
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

pub fn create_custom_tool(db: &Db, body: &Value) -> Result<Value> {
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Ok(json!({ "error": "工具名称不能为空" }));
    }
    if url.is_empty() {
        return Ok(json!({ "error": "调用地址不能为空" }));
    }
    db.with(|conn| {
        let exists: Option<i64> = conn
            .query_row("SELECT id FROM custom_tool WHERE name = ?1", [&name], |r| r.get(0))
            .optional()?;
        if exists.is_some() {
            return Ok(json!({ "error": format!("工具已存在：{name}") }));
        }
        let parameters = body
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        let headers = body.get("headers").cloned().unwrap_or_else(|| json!({}));
        conn.execute(
            "INSERT INTO custom_tool
               (name, description, parameters_json, method, url, headers_json, body_template, enabled, require_approval, builtin, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
            params![
                name,
                body.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                serde_json::to_string(&parameters).unwrap_or_else(|_| "{}".into()),
                body.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_uppercase(),
                url,
                serde_json::to_string(&headers).unwrap_or_else(|_| "{}".into()),
                body.get("body_template").and_then(|v| v.as_str()).unwrap_or(""),
                if body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                if body.get("require_approval").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 },
                now_db(),
            ],
        )?;
        Ok(json!({ "tool_id": conn.last_insert_rowid(), "name": name }))
    })
}

pub fn update_custom_tool(db: &Db, tool_id: i64, body: &Value) -> Result<Value> {
    let exists: Option<i64> = db.with(|conn| {
        Ok(conn
            .query_row("SELECT id FROM custom_tool WHERE id = ?1", [tool_id], |r| r.get(0))
            .optional()?)
    })?;
    if exists.is_none() {
        return Ok(json!({ "error": format!("工具不存在: {tool_id}") }));
    }
    db.with(|conn| {
        for key in ["name", "description", "url", "body_template"] {
            if let Some(v) = body.get(key).and_then(|v| v.as_str()) {
                conn.execute(
                    &format!("UPDATE custom_tool SET {key} = ?1 WHERE id = ?2"),
                    params![v, tool_id],
                )?;
            }
        }
        if let Some(v) = body.get("method").and_then(|v| v.as_str()) {
            conn.execute(
                "UPDATE custom_tool SET method = ?1 WHERE id = ?2",
                params![v.to_uppercase(), tool_id],
            )?;
        }
        if let Some(v) = body.get("parameters") {
            if !v.is_null() {
                conn.execute(
                    "UPDATE custom_tool SET parameters_json = ?1 WHERE id = ?2",
                    params![serde_json::to_string(v).unwrap_or_else(|_| "{}".into()), tool_id],
                )?;
            }
        }
        if let Some(v) = body.get("headers") {
            if !v.is_null() {
                conn.execute(
                    "UPDATE custom_tool SET headers_json = ?1 WHERE id = ?2",
                    params![serde_json::to_string(v).unwrap_or_else(|_| "{}".into()), tool_id],
                )?;
            }
        }
        for key in ["enabled", "require_approval"] {
            if let Some(v) = body.get(key).and_then(|v| v.as_bool()) {
                conn.execute(
                    &format!("UPDATE custom_tool SET {key} = ?1 WHERE id = ?2"),
                    params![v as i64, tool_id],
                )?;
            }
        }
        Ok(json!({ "ok": true, "tool_id": tool_id }))
    })
}

pub fn delete_custom_tool(db: &Db, tool_id: i64) -> Result<Value> {
    db.with(|conn| {
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT name, builtin FROM custom_tool WHERE id = ?1",
                [tool_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let (name, builtin) = match row {
            Some(v) => v,
            None => return Ok(json!({ "error": format!("工具不存在: {tool_id}") })),
        };
        if builtin != 0 {
            return Ok(json!({ "error": "内置工具不可删除" }));
        }
        conn.execute("DELETE FROM custom_tool WHERE id = ?1", [tool_id])?;
        Ok(json!({ "deleted": tool_id, "name": name }))
    })
}

pub fn custom_tool_by_id(db: &Db, tool_id: i64) -> Result<Option<CustomTool>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                &format!("SELECT {TOOL_COLS} FROM custom_tool WHERE id = ?1"),
                [tool_id],
                map_custom_tool,
            )
            .optional()?;
        Ok(row)
    })
}

pub fn custom_tool_by_name(db: &Db, name: &str) -> Result<Option<CustomTool>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                &format!("SELECT {TOOL_COLS} FROM custom_tool WHERE name = ?1 AND enabled = 1"),
                [name],
                map_custom_tool,
            )
            .optional()?;
        Ok(row)
    })
}

pub fn enabled_custom_tools(db: &Db) -> Result<Vec<CustomTool>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {TOOL_COLS} FROM custom_tool WHERE enabled = 1 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], map_custom_tool)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// 模板占位替换：`{arg}` → 参数值
fn render(template: &str, args: &Value) -> String {
    let mut out = template.to_string();
    if let Some(obj) = args.as_object() {
        for (k, v) in obj {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out = out.replace(&format!("{{{k}}}"), &text);
        }
    }
    out
}

/// 执行声明式 HTTP 调用（供 Agent 工具与设置面板"测试"按钮共用）
pub async fn run_custom_tool(row: &CustomTool, args: &Value) -> Value {
    let url = render(&row.url, args);
    let mut req = crate::datasources::http::client().request(
        reqwest::Method::from_bytes(row.method.as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    if let Some(headers) = row.headers.as_object() {
        for (k, v) in headers {
            let value = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            req = req.header(k, render(&value, args));
        }
    }
    if matches!(row.method.as_str(), "POST" | "PUT" | "PATCH") {
        let body = if row.body_template.trim().is_empty() {
            args.clone()
        } else {
            let rendered = render(&row.body_template, args);
            serde_json::from_str(&rendered).unwrap_or(Value::String(rendered))
        };
        req = req.json(&body);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(err) => return json!({ "error": format!("请求失败: {err}") }),
    };
    let status = resp.status();
    let text: String = resp.text().await.unwrap_or_default();
    let snippet: String = text.chars().take(4000).collect();
    if !status.is_success() {
        return json!({
            "error": format!("HTTP {}: {}", status.as_u16(), text.chars().take(300).collect::<String>()),
        });
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(data) => json!({ "status": status.as_u16(), "data": data }),
        Err(_) => json!({ "status": status.as_u16(), "text": snippet }),
    }
}

// ---------------------------------------------------------------------------
// 导入 / 导出（JSON 分享包）
// ---------------------------------------------------------------------------

fn skill_dict(db: &Db, name: &str) -> Result<Option<Value>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT name, description, content FROM skill WHERE name = ?1",
                [name],
                |r| {
                    Ok(json!({
                        "name": r.get::<_, String>(0)?,
                        "description": r.get::<_, String>(1)?,
                        "content": r.get::<_, String>(2)?,
                    }))
                },
            )
            .optional()?;
        Ok(row)
    })
}

pub fn all_skills_dict(db: &Db) -> Result<Vec<Value>> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT name, description, content FROM skill ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(json!({
                    "name": r.get::<_, String>(0)?,
                    "description": r.get::<_, String>(1)?,
                    "content": r.get::<_, String>(2)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// 导出单个预设（含其引用的技能与自定义插件，保证可移植）
pub fn export_preset(db: &Db, preset_id: i64) -> Result<Value> {
    let preset = db.with(|conn| {
        let row = conn
            .query_row(
                &format!("SELECT {PRESET_COLS} FROM agent_preset WHERE id = ?1"),
                [preset_id],
                map_preset,
            )
            .optional()?;
        Ok(row)
    })?;
    let Some(preset) = preset else {
        return Ok(json!({ "error": format!("预设不存在: {preset_id}") }));
    };
    let mut skills = Vec::new();
    for name in &preset.skills {
        if let Some(s) = skill_dict(db, name)? {
            skills.push(s);
        }
    }
    let mut tools = Vec::new();
    for name in &preset.tools {
        let raw = name.strip_prefix("custom_").unwrap_or(name);
        if let Some(row) = custom_tool_by_name_any(db, raw)? {
            tools.push(row.to_json());
        }
    }
    Ok(json!({
        "kind": BUNDLE_KIND,
        "version": BUNDLE_VERSION,
        "exported_at": crate::util::now_iso(),
        "presets": [preset.to_json()],
        "skills": skills,
        "tools": tools,
    }))
}

fn custom_tool_by_name_any(db: &Db, name: &str) -> Result<Option<CustomTool>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                &format!("SELECT {TOOL_COLS} FROM custom_tool WHERE name = ?1"),
                [name],
                map_custom_tool,
            )
            .optional()?;
        Ok(row)
    })
}

pub fn export_all(db: &Db) -> Result<Value> {
    let presets = list_presets(db)?;
    Ok(json!({
        "kind": BUNDLE_KIND,
        "version": BUNDLE_VERSION,
        "exported_at": crate::util::now_iso(),
        "presets": presets.get("items").cloned().unwrap_or(json!([])),
        "skills": all_skills_dict(db)?,
        "tools": list_custom_tools(db)?.get("items").cloned().unwrap_or(json!([])),
    }))
}

fn unique_name(db: &Db, table: &str, name: &str) -> Result<String> {
    let mut candidate = name.to_string();
    let mut i = 1;
    loop {
        let exists: Option<i64> = db.with(|conn| {
            Ok(conn
                .query_row(
                    &format!("SELECT id FROM {table} WHERE name = ?1"),
                    [&candidate],
                    |r| r.get(0),
                )
                .optional()?)
        })?;
        if exists.is_none() {
            return Ok(candidate);
        }
        i += 1;
        candidate = format!("{name}（导入{i}）");
    }
}

/// 导入分享包。strategy: skip（跳过同名）/ rename（重命名）/ overwrite（覆盖）
pub fn import_bundle(db: &Db, data: &Value, strategy: &str) -> Result<Value> {
    if data.get("kind").and_then(|v| v.as_str()) != Some(BUNDLE_KIND) {
        return Ok(json!({ "error": format!("不是有效的分享包（kind 应为 {BUNDLE_KIND}）") }));
    }
    let version = data.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    if version > BUNDLE_VERSION {
        return Ok(json!({
            "error": format!("分享包版本过新（{version} > {BUNDLE_VERSION}），请升级平台"),
        }));
    }

    let mut result_tools: Vec<String> = Vec::new();
    let mut result_skills: Vec<String> = Vec::new();
    let mut result_presets: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // 1) 插件
    for t in data.get("tools").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let method = t.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_uppercase();
        let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let existing = custom_tool_by_name_any(db, &name)?;
        if let Some(row) = &existing {
            if row.url == url && row.method == method {
                result_tools.push(format!("{name}（已存在，复用）"));
                continue;
            }
            if strategy == "skip" {
                skipped.push(format!("插件 {name}"));
                continue;
            }
        }
        let params = t.get("parameters").cloned().unwrap_or_else(|| json!({}));
        let headers = t.get("headers").cloned().unwrap_or_else(|| json!({}));
        let require_approval = t.get("require_approval").and_then(|v| v.as_bool()).unwrap_or(false);
        let description = t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let body_template = t.get("body_template").and_then(|v| v.as_str()).unwrap_or("").to_string();
        match existing {
            Some(row) => {
                update_custom_tool(
                    db,
                    row.id,
                    &json!({
                        "description": description, "parameters": params, "method": method, "url": url,
                        "headers": headers, "body_template": body_template, "require_approval": require_approval,
                    }),
                )?;
                result_tools.push(format!("{name}（覆盖）"));
            }
            None => {
                let final_name = if strategy == "rename" {
                    unique_name(db, "custom_tool", &name)?
                } else {
                    name.clone()
                };
                db.with(|conn| {
                    conn.execute(
                        "INSERT INTO custom_tool
                           (name, description, parameters_json, method, url, headers_json, body_template, enabled, require_approval, builtin, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, 0, ?9)",
                        params![
                            final_name,
                            description,
                            serde_json::to_string(&params).unwrap_or_else(|_| "{}".into()),
                            method,
                            url,
                            serde_json::to_string(&headers).unwrap_or_else(|_| "{}".into()),
                            body_template,
                            require_approval as i64,
                            now_db(),
                        ],
                    )?;
                    Ok(())
                })?;
                result_tools.push(final_name);
            }
        }
    }

    // 2) 技能
    for s in data.get("skills").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let content = s.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() || content.trim().is_empty() {
            continue;
        }
        let description = s.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let existing = crate::services::skills::get_by_name(db, &name)?;
        if let Some((_, _, existing_content, _)) = &existing {
            if existing_content.trim() == content.trim() {
                result_skills.push(format!("{name}（已存在，复用）"));
                continue;
            }
            if strategy == "skip" {
                skipped.push(format!("技能 {name}"));
                continue;
            }
        }
        if existing.is_some() {
            db.with(|conn| {
                conn.execute(
                    "UPDATE skill SET description = ?1, content = ?2, updated_at = ?3 WHERE name = ?4",
                    params![description, content, now_db(), name],
                )?;
                Ok(())
            })?;
            result_skills.push(format!("{name}（覆盖）"));
        } else {
            let final_name = if strategy == "rename" {
                unique_name(db, "skill", &name)?
            } else {
                name.clone()
            };
            db.with(|conn| {
                let now = now_db();
                conn.execute(
                    "INSERT INTO skill (name, description, content, enabled, builtin, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 1, 0, ?4, ?4)",
                    params![final_name, description, content, now],
                )?;
                Ok(())
            })?;
            result_skills.push(final_name);
        }
    }

    // 3) 预设（最后导入，工具/技能已就位）
    for p in data.get("presets").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let existing: Option<i64> = db.with(|conn| {
            Ok(conn
                .query_row("SELECT id FROM agent_preset WHERE name = ?1", [&name], |r| r.get(0))
                .optional()?)
        })?;
        if existing.is_some() && strategy == "skip" {
            skipped.push(format!("预设 {name}"));
            continue;
        }
        let payload_keys = ["description", "prompt_extra", "model_override"];
        let tools: Vec<String> = str_list(p.get("tools").unwrap_or(&json!([])));
        let skills: Vec<String> = str_list(p.get("skills").unwrap_or(&json!([])));
        match existing {
            Some(id) => {
                let mut body = json!({ "tools": tools, "skills": skills });
                for k in payload_keys {
                    body[k] = p.get(k).cloned().unwrap_or(json!(""));
                }
                update_preset(db, id, &body)?;
                result_presets.push(format!("{name}（覆盖）"));
            }
            None => {
                let final_name = if strategy == "rename" {
                    unique_name(db, "agent_preset", &name)?
                } else {
                    name.clone()
                };
                db.with(|conn| {
                    let now = now_db();
                    conn.execute(
                        "INSERT INTO agent_preset
                           (name, description, prompt_extra, tools_json, skills_json, model_override, enabled, builtin, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?7)",
                        params![
                            final_name,
                            p.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                            p.get("prompt_extra").and_then(|v| v.as_str()).unwrap_or(""),
                            serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&skills).unwrap_or_else(|_| "[]".into()),
                            p.get("model_override").and_then(|v| v.as_str()).unwrap_or(""),
                            now,
                        ],
                    )?;
                    Ok(())
                })?;
                result_presets.push(final_name);
            }
        }
    }

    Ok(json!({
        "tools": result_tools,
        "skills": result_skills,
        "presets": result_presets,
        "skipped": skipped,
        "strategy": strategy,
    }))
}

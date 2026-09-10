//! 工具注册表与内置工具（P1：仅依赖本地数据库的只读工具；网络类工具在 P2/P3 接入）。
//!
//! 与 Python 版 `app/agent/tools.py` 的差异：注册表在启动时构建一次（静态 schema
//! 顺序稳定 → 前缀缓存友好），工具处理函数统一签名 `fn(&Db, &Value) -> Value`。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::db::Db;
use crate::services::rules;

/// 股票代码归一：600519 / SH600519 / sh.600519 / 600519.SH / 000001.XSHE → 600519
pub fn normalize_code(raw: &str) -> Option<String> {
    let s: String = raw
        .trim()
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if s.is_empty() {
        return None;
    }
    let stripped = s
        .strip_prefix("SH")
        .or_else(|| s.strip_prefix("SZ"))
        .or_else(|| s.strip_prefix("BJ"))
        .or_else(|| s.strip_prefix("SS"))
        .unwrap_or(&s)
        .trim_start_matches('.');
    let core = stripped
        .strip_suffix(".SH")
        .or_else(|| stripped.strip_suffix(".SZ"))
        .or_else(|| stripped.strip_suffix(".BJ"))
        .or_else(|| stripped.strip_suffix(".SS"))
        .or_else(|| stripped.strip_suffix(".XSHE"))
        .or_else(|| stripped.strip_suffix(".XSHG"))
        .unwrap_or(stripped);
    if core.len() == 6 && core.chars().all(|c| c.is_ascii_digit()) {
        Some(core.to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub read_only: bool,
}

impl ToolDef {
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        })
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDef>,
}

impl ToolRegistry {
    pub fn register(&mut self, name: &str, description: &str, parameters: Value, read_only: bool) {
        self.tools.insert(
            name.to_string(),
            ToolDef {
                name: name.to_string(),
                description: description.to_string(),
                parameters,
                read_only,
            },
        );
    }

    pub fn definitions(&self) -> Vec<Value> {
        self.tools.values().map(|t| t.schema()).collect()
    }

    pub fn get(&self, name: &str) -> Option<&ToolDef> {
        self.tools.get(name)
    }

    #[allow(dead_code)]
    pub fn names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn arg_i64(args: &Value, key: &str, default: i64) -> i64 {
    args.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/// 按名称、行业或股票代码检索企业（代码优先精确匹配）
pub fn search_enterprise(db: &Db, args: &Value) -> Value {
    let kw = arg_str(args, "keyword");
    let limit = arg_i64(args, "limit", 5).clamp(1, 50);
    let code = normalize_code(&kw);

    if let Some(code) = &code {
        let hit = db.with(|conn| {
            let row = conn.query_row(
                "SELECT id, name, industry FROM enterprise WHERE stock_code = ?1",
                [code],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
            );
            match row {
                Ok(v) => Ok(Some(v)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        });
        if let Ok(Some((id, name, industry))) = hit {
            let verdict = rules::rules_verdict(db, id).ok();
            let brief = match verdict {
                Some(v) => rules::brief(db, id, &name, &industry, &v),
                None => json!({ "id": id, "name": name, "industry": industry }),
            };
            return json!({
                "count": 1,
                "enterprises": [brief],
                "hint": "如需详细画像请调用 get_score_profile(enterprise_id)",
            });
        }
    }

    let like = format!("%{kw}%");
    let rows = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, industry FROM enterprise
             WHERE name LIKE ?1 OR industry LIKE ?1 OR stock_code LIKE ?1 OR unified_code LIKE ?1
             ORDER BY id LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![like, limit], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .unwrap_or_default();

    let mut enterprises = Vec::new();
    for (id, name, industry) in &rows {
        match rules::rules_verdict(db, *id) {
            Ok(v) => enterprises.push(rules::brief(db, *id, name, industry, &v)),
            Err(_) => enterprises.push(json!({ "id": id, "name": name, "industry": industry })),
        }
    }

    if enterprises.is_empty() {
        return json!({
            "count": 0,
            "enterprises": [],
            "hint": if code.is_some() {
                format!("平台内未找到股票代码 {} 对应的企业；可调用 add_enterprise 添加建档", kw)
            } else {
                "未找到企业，可尝试其他关键词，或直接输入股票代码".to_string()
            },
        });
    }
    json!({
        "count": enterprises.len(),
        "enterprises": enterprises,
        "hint": "如需详细画像请调用 get_score_profile(enterprise_id)",
    })
}

/// 六维评分画像
pub fn get_score_profile(db: &Db, args: &Value) -> Value {
    let id = arg_i64(args, "enterprise_id", 0);
    let ent = db
        .with(|conn| {
            let row = conn.query_row(
                "SELECT name, industry, legal_rep, reg_date, data_note FROM enterprise WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            );
            match row {
                Ok(v) => Ok(Some(v)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
        .unwrap_or(None);
    let Some((name, industry, legal_rep, reg_date, data_note)) = ent else {
        return json!({ "error": format!("企业不存在: {id}") });
    };
    let verdict = match rules::rules_verdict(db, id) {
        Ok(v) => v,
        Err(err) => return json!({ "error": format!("评分失败: {err}") }),
    };
    let dimensions: serde_json::Map<String, Value> = verdict
        .dimensions
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                json!({
                    "label": v.label,
                    "score": v.score,
                    "level": v.level,
                    "note": v.note,
                }),
            )
        })
        .collect();
    json!({
        "enterprise": { "id": id, "name": name, "industry": industry,
                        "legal_rep": legal_rep, "reg_date": reg_date, "data_note": data_note },
        "score": verdict.score,
        "grade": verdict.grade,
        "grade_label": verdict.grade_label,
        "level": verdict.level,
        "dimensions": dimensions,
    })
}

/// 风险事实
pub fn get_risk_facts(db: &Db, args: &Value) -> Value {
    let id = arg_i64(args, "enterprise_id", 0);
    let dimension = arg_str(args, "dimension");
    let limit = arg_i64(args, "limit", 10).clamp(1, 50);
    let rows = db
        .with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT dimension, text, evidence_json, confidence FROM risk_fact
                 WHERE enterprise_id = ?1 AND (?2 = '' OR dimension = ?2)
                 ORDER BY ts DESC LIMIT ?3",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![id, dimension, limit], |r| {
                    let evidence: String = r.get(2)?;
                    Ok(json!({
                        "dimension": r.get::<_, String>(0)?,
                        "text": r.get::<_, String>(1)?,
                        "evidence": serde_json::from_str::<Value>(&evidence).unwrap_or(json!({})),
                        "confidence": r.get::<_, f64>(3)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();
    let name: String = db
        .with(|conn| {
            Ok(conn
                .query_row("SELECT name FROM enterprise WHERE id = ?1", [id], |r| r.get(0))
                .unwrap_or_default())
        })
        .unwrap_or_default();
    json!({ "enterprise_id": id, "enterprise_name": name, "count": rows.len(), "facts": rows })
}

/// 按风险等级列企业（按评分升序）
pub fn list_enterprises_by_level(db: &Db, args: &Value) -> Value {
    let level = {
        let l = arg_str(args, "level");
        if l.is_empty() { "red".to_string() } else { l }
    };
    let rows = db
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT id, name, industry FROM enterprise ORDER BY id")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();

    let mut out: Vec<Value> = Vec::new();
    for (id, name, industry) in &rows {
        if let Ok(v) = rules::rules_verdict(db, *id) {
            if v.level == level {
                out.push(rules::brief(db, *id, name, industry, &v));
            }
        }
    }
    out.sort_by(|a, b| {
        let sa = a.get("score").and_then(|v| v.as_f64()).unwrap_or(999.0);
        let sb = b.get("score").and_then(|v| v.as_f64()).unwrap_or(999.0);
        sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
    });
    json!({ "level": level, "count": out.len(), "enterprises": out })
}

/// 平台总览
pub fn get_platform_overview(db: &Db, _args: &Value) -> Value {
    let rows = db
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM enterprise ORDER BY id")?;
            let rows = stmt.query_map([], |r| Ok(r.get::<_, i64>(0)?))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();

    let mut levels: BTreeMap<String, i64> = BTreeMap::new();
    let mut scores: Vec<f64> = Vec::new();
    for id in &rows {
        if let Ok(v) = rules::rules_verdict(db, *id) {
            *levels.entry(v.level.clone()).or_insert(0) += 1;
            if let Some(s) = v.score {
                scores.push(s);
            }
        }
    }
    let avg = if scores.is_empty() {
        Value::Null
    } else {
        json!(((scores.iter().sum::<f64>() / scores.len() as f64) * 10.0).round() / 10.0)
    };
    let fact_total: i64 = db
        .with(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM risk_fact", [], |r| r.get(0))?))
        .unwrap_or(0);
    let news_sentiment: BTreeMap<String, i64> = db
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT sentiment, COUNT(*) FROM news GROUP BY sentiment")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default()
        .into_iter()
        .collect();

    json!({
        "enterprise_total": rows.len(),
        "avg_score": avg,
        "level_counts": levels,
        "risk_fact_total": fact_total,
        "news_sentiment": news_sentiment,
    })
}

/// 预警工单列表
pub fn list_alerts(db: &Db, args: &Value) -> Value {
    let status = arg_str(args, "status");
    let level = arg_str(args, "level");
    let enterprise_id = arg_i64(args, "enterprise_id", 0);
    let limit = arg_i64(args, "limit", 10).clamp(1, 100);
    let rows = db
        .with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.enterprise_id, e.name, a.level, a.dimension, a.title, a.summary,
                        a.score, a.status, a.created_at, a.updated_at
                 FROM alert a JOIN enterprise e ON e.id = a.enterprise_id
                 WHERE (?1 = '' OR a.status = ?1) AND (?2 = '' OR a.level = ?2)
                   AND (?3 = 0 OR a.enterprise_id = ?3)
                 ORDER BY a.created_at DESC LIMIT ?4",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![status, level, enterprise_id, limit], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "enterprise_id": r.get::<_, i64>(1)?,
                        "enterprise": r.get::<_, String>(2)?,
                        "level": r.get::<_, String>(3)?,
                        "dimension": r.get::<_, String>(4)?,
                        "title": r.get::<_, String>(5)?,
                        "summary": r.get::<_, String>(6)?,
                        "score": r.get::<_, Option<f64>>(7)?,
                        "status": r.get::<_, String>(8)?,
                        "created_at": r.get::<_, String>(9)?,
                        "updated_at": r.get::<_, String>(10)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();
    json!({ "total": rows.len(), "items": rows })
}

/// 列出技能（只给名称与描述，避免污染上下文）
pub fn list_skills(db: &Db, _args: &Value) -> Value {
    let rows = db
        .with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name, description FROM skill WHERE enabled = 1 ORDER BY id",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(json!({ "name": r.get::<_, String>(0)?, "description": r.get::<_, String>(1)? }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();
    json!({
        "count": rows.len(),
        "skills": rows,
        "hint": "选定后用 load_skill(name) 载入该技能的完整执行指令",
    })
}

/// 载入技能全文
pub fn load_skill(db: &Db, args: &Value) -> Value {
    let name = arg_str(args, "name");
    let row = db.with(|conn| {
        let r = conn.query_row(
            "SELECT name, description, content FROM skill WHERE name = ?1 AND enabled = 1",
            [&name],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        );
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    });
    match row.unwrap_or(None) {
        Some((name, description, content)) => {
            json!({ "skill": name, "description": description, "instructions": content })
        }
        None => json!({ "error": format!("技能不存在或已停用：{name}") }),
    }
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

pub fn build_registry() -> ToolRegistry {
    let mut reg = ToolRegistry::default();

    reg.register(
        "search_enterprise",
        "按企业名称、行业关键词或股票代码搜索企业（如「康美药业」「600518」「SH600519」），返回 id/名称/行业/评分/等级。首次接触某企业时先调用它拿到 id。",
        json!({
            "type": "object",
            "properties": {
                "keyword": { "type": "string", "description": "企业名称、行业关键词或股票代码（6 位数字，可带 SH/SZ 前后缀）" },
                "limit": { "type": "integer", "description": "返回条数，默认 5" }
            },
            "required": ["keyword"]
        }),
        true,
    );

    reg.register(
        "get_score_profile",
        "获取指定企业的六维评分画像（财务健康/法律合规/舆情声誉/经营能力/信用状况/供应链稳定）、综合评分与 AAA~C 评级。",
        json!({
            "type": "object",
            "properties": { "enterprise_id": { "type": "integer", "description": "企业 id（来自 search_enterprise）" } },
            "required": ["enterprise_id"]
        }),
        true,
    );

    reg.register(
        "get_risk_facts",
        "获取企业已沉淀的风险事实与证据（含来源与置信度），可按维度筛选。",
        json!({
            "type": "object",
            "properties": {
                "enterprise_id": { "type": "integer" },
                "dimension": { "type": "string", "description": "可选：finance/legal/news/operation/credit/supply" },
                "limit": { "type": "integer", "description": "默认 10" }
            },
            "required": ["enterprise_id"]
        }),
        true,
    );

    reg.register(
        "list_enterprises_by_level",
        "列出指定风险等级的企业（red/orange/yellow/green），按评分升序。",
        json!({
            "type": "object",
            "properties": { "level": { "type": "string", "description": "red/orange/yellow/green，默认 red" } },
            "required": []
        }),
        true,
    );

    reg.register(
        "get_platform_overview",
        "获取平台整体统计：企业总数、平均评分、各风险等级数量、风险事实总数。",
        json!({ "type": "object", "properties": {}, "required": [] }),
        true,
    );

    reg.register(
        "list_alerts",
        "查询预警工单：可按状态（pending/handling/resolved/ignored）、等级（red/orange/yellow）、企业 id 筛选。",
        json!({
            "type": "object",
            "properties": {
                "status": { "type": "string" },
                "level": { "type": "string" },
                "enterprise_id": { "type": "integer" },
                "limit": { "type": "integer", "description": "默认 10" }
            },
            "required": []
        }),
        true,
    );

    reg.register(
        "list_skills",
        "列出平台可用技能（如「企业风险评估报告」「财务分析」）。需要专门分析方法时先调用它。",
        json!({ "type": "object", "properties": {}, "required": [] }),
        true,
    );

    reg.register(
        "load_skill",
        "载入指定技能的完整执行指令，然后严格按该指令完成任务。",
        json!({
            "type": "object",
            "properties": { "name": { "type": "string", "description": "技能名称（来自 list_skills）" } },
            "required": ["name"]
        }),
        true,
    );

    reg.register(
        "get_alert_report",
        "生成指定预警的处置报告（Markdown 文本，含证据链与处理流水）。",
        json!({
            "type": "object",
            "properties": { "alert_id": { "type": "integer" } },
            "required": ["alert_id"]
        }),
        true,
    );

    reg.register(
        "resolve_stock_code",
        "按企业名称或股票代码查询 A 股标的（用于添加企业前确认）：输入名称返回代码，输入代码返回证券简称。",
        json!({
            "type": "object",
            "properties": { "name": { "type": "string", "description": "企业名称关键词，或 6 位股票代码（可带 SH/SZ 前后缀）" } },
            "required": ["name"]
        }),
        true,
    );

    reg.register(
        "add_enterprise",
        "添加一家新企业到平台（可自动解析股票代码并拉取公开数据：财报/公告/诉讼）。这是写操作，需用户授权。",
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "企业全称或常用名，也可直接填股票代码" },
                "stock_code": { "type": "string", "description": "可选：A股代码（不填则按名称自动解析）" },
                "auto_fetch": { "type": "boolean", "description": "是否自动拉取公开数据，默认 true" }
            },
            "required": ["name"]
        }),
        false,
    );

    reg.register(
        "refresh_enterprise_data",
        "从公开数据源刷新指定企业的数据并入库（finance/news/legal）。写操作，需用户授权。",
        json!({
            "type": "object",
            "properties": {
                "enterprise_id": { "type": "integer" },
                "dimensions": { "type": "string", "description": "可选：逗号分隔的维度 finance,news,legal；默认全部" }
            },
            "required": ["enterprise_id"]
        }),
        false,
    );

    reg.register(
        "handle_alert",
        "处置预警工单（写操作，需授权）：start=开始处理，resolve=标记已处置，ignore=忽略，reopen=重新打开。",
        json!({
            "type": "object",
            "properties": {
                "alert_id": { "type": "integer" },
                "action": { "type": "string", "description": "start/resolve/ignore/reopen" },
                "handler": { "type": "string", "description": "处理人" },
                "note": { "type": "string", "description": "处置说明" }
            },
            "required": ["alert_id", "action"]
        }),
        false,
    );

    reg
}

/// 同步工具分发（只读且无网络的工具）
pub fn call_tool(db: &Db, name: &str, args: &Value) -> Value {
    match name {
        "search_enterprise" => search_enterprise(db, args),
        "get_score_profile" => get_score_profile(db, args),
        "get_risk_facts" => get_risk_facts(db, args),
        "list_enterprises_by_level" => list_enterprises_by_level(db, args),
        "get_platform_overview" => get_platform_overview(db, args),
        "list_alerts" => list_alerts(db, args),
        "get_alert_report" => get_alert_report(db, args),
        "list_skills" => list_skills(db, args),
        "load_skill" => load_skill(db, args),
        other => json!({ "error": format!("unknown tool: {other}") }),
    }
}

/// 预警报告（Markdown，只读）
pub fn get_alert_report(db: &Db, args: &Value) -> Value {
    let alert_id = arg_i64(args, "alert_id", 0);
    match crate::services::alerts::report_markdown(db, alert_id) {
        Ok(text) if !text.is_empty() => json!({ "alert_id": alert_id, "report_markdown": text }),
        Ok(_) => json!({ "error": format!("预警不存在: {alert_id}") }),
        Err(err) => json!({ "error": format!("生成报告失败: {err}") }),
    }
}

/// 需要网络或写库的异步工具
pub fn is_async_tool(name: &str) -> bool {
    matches!(
        name,
        "resolve_stock_code" | "add_enterprise" | "refresh_enterprise_data" | "handle_alert"
    )
}

/// 异步工具分发（网络 + 写操作）
pub async fn call_tool_async(state: &crate::state::AppState, name: &str, args: &Value) -> Value {
    match name {
        "resolve_stock_code" => {
            let query = arg_str(args, "name");
            crate::services::enterprise::lookup_stock_async(&query).await
        }
        "add_enterprise" => {
            let name = arg_str(args, "name");
            let code = args.get("stock_code").and_then(|v| v.as_str()).map(|s| s.to_string());
            let auto_fetch = arg_bool(args, "auto_fetch", true);
            match crate::services::enterprise::create_enterprise(
                &state.db, &name, code.as_deref(), auto_fetch, "",
            )
            .await
            {
                Ok(v) if v.get("refresh").is_some() => json!({
                    "ok": true,
                    "enterprise_id": v.get("enterprise_id"),
                    "name": v.get("name"),
                    "stock_code": v.get("stock_code"),
                    "resolved_from": v.get("resolved_from"),
                    "dimensions": v.get("refresh").and_then(|r| r.get("dimensions")).cloned().unwrap_or(json!({})),
                    "hint": "可继续调用 get_score_profile 查看评分",
                }),
                Ok(v) => v,
                Err(err) => json!({ "error": format!("添加失败: {err}") }),
            }
        }
        "refresh_enterprise_data" => {
            let enterprise_id = arg_i64(args, "enterprise_id", 0);
            let dims = {
                let raw = arg_str(args, "dimensions");
                let list: Vec<String> = raw
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if list.is_empty() { None } else { Some(list) }
            };
            match crate::datasources::refresh_enterprise(&state.db, enterprise_id, dims).await {
                Ok(v) => {
                    if let Some(err) = v.get("error") {
                        return json!({ "error": err });
                    }
                    let summary: serde_json::Map<String, Value> = v
                        .get("dimensions")
                        .and_then(|d| d.as_object())
                        .map(|m| {
                            m.iter()
                                .map(|(k, info)| {
                                    let text = if info.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                                        format!(
                                            "新增 {}/更新 {}",
                                            info.get("inserted").and_then(|x| x.as_i64()).unwrap_or(0),
                                            info.get("updated").and_then(|x| x.as_i64()).unwrap_or(0)
                                        )
                                    } else {
                                        info.get("error")
                                            .or_else(|| info.get("gap"))
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("无数据")
                                            .to_string()
                                    };
                                    (k.clone(), json!(text))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({
                        "ok": true,
                        "enterprise_id": enterprise_id,
                        "enterprise": v.get("enterprise").and_then(|e| e.get("name")),
                        "dimensions": summary,
                        "data_status": v.get("data_status"),
                        "alerts_created": v.get("alerts_created"),
                    })
                }
                Err(err) => json!({ "error": format!("刷新失败: {err}") }),
            }
        }
        "handle_alert" => {
            let alert_id = arg_i64(args, "alert_id", 0);
            let action = arg_str(args, "action");
            let handler = arg_str(args, "handler");
            let note = arg_str(args, "note");
            match crate::services::alerts::handle_alert(&state.db, alert_id, &action, &handler, &note) {
                Ok(v) => v,
                Err(err) => json!({ "error": format!("处置失败: {err}") }),
            }
        }
        other => json!({ "error": format!("unknown async tool: {other}") }),
    }
}

#[allow(dead_code)]
fn _unused(_b: bool) {
    let _ = arg_bool(&json!({}), "x", false);
}

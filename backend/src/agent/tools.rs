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

    pub fn is_read_only(&self, name: &str) -> bool {
        self.tools.get(name).map(|t| t.read_only).unwrap_or(true)
    }

    /// 预设工具白名单过滤：`list_skills` / `load_skill` 始终保留（便于技能发现）
    pub fn retain_whitelist(&mut self, allowed: &[String]) {
        if allowed.is_empty() {
            return;
        }
        const ALWAYS: [&str; 2] = ["list_skills", "load_skill"];
        self.tools
            .retain(|name, _| allowed.iter().any(|a| a == name) || ALWAYS.contains(&name.as_str()));
    }

    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
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
                        "created_at": crate::util::db_to_iso(&r.get::<_, String>(9)?),
                        "updated_at": crate::util::db_to_iso(&r.get::<_, String>(10)?),
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();
    json!({ "total": rows.len(), "items": rows })
}

/// 列出技能（只给名称与描述，避免污染上下文）；预设技能白名单生效时只列白名单内技能
pub fn list_skills(db: &Db, _args: &Value, allowed_skills: &[String]) -> Value {
    let rows = crate::services::skills::skills_for_tool(db).unwrap_or_default();
    let rows: Vec<Value> = rows
        .into_iter()
        .filter(|s| {
            allowed_skills.is_empty()
                || s.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| allowed_skills.iter().any(|a| a == n))
                    .unwrap_or(false)
        })
        .collect();
    json!({
        "count": rows.len(),
        "skills": rows,
        "hint": "选定后用 load_skill(name) 载入该技能的完整执行指令",
    })
}

/// 载入技能全文
pub fn load_skill(db: &Db, args: &Value, allowed_skills: &[String]) -> Value {
    let name = arg_str(args, "name");
    if !allowed_skills.is_empty() && !allowed_skills.iter().any(|a| a == &name) {
        let mut available = allowed_skills.to_vec();
        available.sort();
        return json!({
            "error": format!("当前预设未启用该技能：{name}"),
            "available": available,
        });
    }
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
        None => {
            let available = db
                .with(|conn| {
                    let mut stmt =
                        conn.prepare("SELECT name FROM skill WHERE enabled = 1 ORDER BY id")?;
                    let rows = stmt
                        .query_map([], |r| r.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(rows)
                })
                .unwrap_or_default();
            json!({
                "error": format!("技能不存在或已停用：{name}"),
                "available": available,
            })
        }
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
        "run_risk_analysis",
        "触发指定企业的完整风险研判（调用多模态大模型取数推理 + 规则引擎交叉校验），耗时 10~40 秒。仅在用户明确要求分析/重新研判时使用。",
        json!({
            "type": "object",
            "properties": { "enterprise_id": { "type": "integer" } },
            "required": ["enterprise_id"]
        }),
        false,
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

    reg.register(
        "get_financial_analysis",
        "金融分析模块：返回企业的财务 KPI、杜邦分解、Altman Z/Z''、Piotroski F、Beneish M 模型结论、同业对标分位与异常勾稽信号。用户问财务/财报/盈利质量/偿债能力/是否可能财务造假时使用。",
        json!({
            "type": "object",
            "properties": {
                "enterprise_id": { "type": "integer", "description": "企业 id（来自 search_enterprise）" },
                "include_peers": { "type": "boolean", "description": "是否返回同业对标，默认 true" }
            },
            "required": ["enterprise_id"]
        }),
        true,
    );

    reg.register(
        "compare_financials",
        "多家企业财务横向对比（最多 5 家）：营收/利润/增速/毛利率/净利率/ROE/资产负债率/现金流与模型结论。",
        json!({
            "type": "object",
            "properties": {
                "enterprise_ids": { "type": "array", "items": { "type": "integer" }, "description": "2~5 个企业 id" }
            },
            "required": ["enterprise_ids"]
        }),
        true,
    );

    reg.register(
        "screen_by_financial_metric",
        "按财务指标筛选企业，例如'毛利率低于 20%''资产负债率高于 70%''营收负增长'。可用指标：revenue/net_profit/revenue_growth/gross_margin/net_margin/roe/debt_ratio。",
        json!({
            "type": "object",
            "properties": {
                "metric": { "type": "string", "description": "指标 key" },
                "op": { "type": "string", "description": "lt/le/gt/ge，默认 lt" },
                "value": { "type": "number", "description": "阈值" },
                "limit": { "type": "integer", "description": "返回条数，默认 10" }
            },
            "required": ["metric", "op", "value"]
        }),
        true,
    );

    reg
}

/// 每次运行构建注册表：内置工具（按预设白名单过滤）+ 用户手搓插件 + 启用的 MCP 工具。
///
/// 顺序稳定性：`BTreeMap` 按名称排序输出，前缀缓存友好（新增插件会改变 tools 数组，
/// 此时前缀缓存失效一次，属预期）。
pub fn build_registry_for(
    db: &Db,
    preset: Option<&crate::services::presets::Preset>,
) -> ToolRegistry {
    let mut reg = build_registry();
    if let Some(p) = preset {
        reg.retain_whitelist(&p.tools);
    }
    // 插件（自定义 HTTP 工具）：预设白名单非空时同样受过滤
    for tool in crate::services::presets::enabled_custom_tools(db).unwrap_or_default() {
        let name = format!("custom_{}", tool.name);
        let name: String = name.chars().take(64).collect();
        if reg.contains(&name) {
            continue; // 与内置工具重名：保留内置
        }
        if let Some(p) = preset {
            if !p.tools.is_empty() && !p.tools.iter().any(|t| t == &name || t == &tool.name) {
                continue;
            }
        }
        reg.register(
            &name,
            &format!("[插件] {}", if tool.description.is_empty() { tool.name.clone() } else { tool.description.clone() }),
            if tool.parameters.is_object() && tool.parameters.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                tool.parameters.clone()
            } else {
                json!({ "type": "object", "properties": {} })
            },
            !tool.require_approval,
        );
    }
    // MCP 外部工具
    for item in crate::services::mcp::enabled_tools(db).unwrap_or_default() {
        if reg.contains(&item.openai_name) {
            continue;
        }
        if let Some(p) = preset {
            if !p.tools.is_empty() && !p.tools.iter().any(|t| t == &item.openai_name) {
                continue;
            }
        }
        let description = if item.description.is_empty() {
            format!("[MCP:{}] {}", item.server_name, item.name)
        } else {
            format!("[MCP:{}] {}", item.server_name, item.description)
        };
        reg.register(
            &item.openai_name,
            &description,
            if item.input_schema.is_object() { item.input_schema.clone() } else { json!({ "type": "object", "properties": {} }) },
            !item.require_approval,
        );
    }
    reg
}

/// 同步工具分发（只读且无网络的工具）
pub fn call_tool(db: &Db, name: &str, args: &Value, allowed_skills: &[String]) -> Value {
    match name {
        "search_enterprise" => search_enterprise(db, args),
        "get_score_profile" => get_score_profile(db, args),
        "get_risk_facts" => get_risk_facts(db, args),
        "list_enterprises_by_level" => list_enterprises_by_level(db, args),
        "get_platform_overview" => get_platform_overview(db, args),
        "list_alerts" => list_alerts(db, args),
        "get_alert_report" => get_alert_report(db, args),
        "get_financial_analysis" => get_financial_analysis(db, args),
        "compare_financials" => compare_financials(db, args),
        "screen_by_financial_metric" => screen_by_financial_metric(db, args),
        "list_skills" => list_skills(db, args, allowed_skills),
        "load_skill" => load_skill(db, args, allowed_skills),
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


/// 金融分析模块：KPI / 杜邦 / Z·F·M 模型 / 同业对标 / 异常勾稽（精简返回，避免上下文膨胀）
pub fn get_financial_analysis(db: &Db, args: &Value) -> Value {
    let id = arg_i64(args, "enterprise_id", 0);
    let include_peers = arg_bool(args, "include_peers", true);
    match crate::services::finance::analysis(db, id, 5, include_peers) {
        Ok(a) if a.get("error").is_some() => a,
        Ok(a) if a.get("available") != Some(&json!(true)) => json!({
            "enterprise": a.get("enterprise"),
            "available": false,
            "reason": a.get("reason"),
            "data_status": a.get("data_status"),
            "hint": "可用 refresh_enterprise_data 拉取公开财报，或确认企业是否有股票代码",
        }),
        Ok(a) => {
            let m = &a["models"];
            let kpi: Vec<Value> = a["kpi"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|k| k["available"] == json!(true))
                .map(|k| {
                    json!({
                        "key": k["key"], "label": k["label"], "unit": k["unit"],
                        "value": k["value"], "prev": k["prev"], "yoy": k["yoy"], "trend": k["trend"],
                    })
                })
                .collect();
            let failed: Vec<Value> = m["piotroski"]["signals"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s["pass"] == json!(false))
                .map(|s| json!(s["name"]))
                .collect();
            json!({
                "enterprise": a["enterprise"],
                "available": true,
                "latest_year": a["latest_year"],
                "kpi": kpi,
                "dupont": a["dupont"],
                "models": {
                    "altman_z": { "score": m["altman"]["z"]["score"], "verdict": m["altman"]["z"]["verdict"],
                                  "available": m["altman"]["z"]["available"], "missing": m["altman"]["z"]["missing"] },
                    "altman_z2": { "score": m["altman"]["z2"]["score"], "verdict": m["altman"]["z2"]["verdict"],
                                   "available": m["altman"]["z2"]["available"] },
                    "piotroski_f": { "score": m["piotroski"]["score"], "max_score": m["piotroski"]["max_score"],
                                     "verdict": m["piotroski"]["verdict"], "failed": failed,
                                     "note": m["piotroski"]["note"] },
                    "beneish_m": { "score": m["beneish"]["score"], "verdict": m["beneish"]["verdict"],
                                   "available": m["beneish"]["available"], "missing": m["beneish"]["missing"],
                                   "note": m["beneish"]["note"] },
                },
                "anomalies": a["anomalies"],
                "peers": if include_peers {
                    json!({
                        "industry": a["peers"]["industry"],
                        "note": a["peers"]["note"],
                        "rows": a["peers"]["rows"].as_array().cloned().unwrap_or_default().into_iter()
                            .map(|r| json!({ "name": r["name"], "is_self": r["is_self"], "year": r["year"],
                                             "metrics": r["metrics"], "percentiles": r["percentiles"] }))
                            .collect::<Vec<_>>(),
                    })
                } else { Value::Null },
                "data_quality": a["data_quality"],
            })
        }
        Err(err) => json!({ "error": format!("金融分析失败: {err}") }),
    }
}

/// 多家企业财务横向对比（最多 5 家）
pub fn compare_financials(db: &Db, args: &Value) -> Value {
    let ids: Vec<i64> = args
        .get("enterprise_ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).take(5).collect())
        .unwrap_or_default();
    if ids.len() < 2 {
        return json!({ "error": "至少需要 2 个 enterprise_id" });
    }
    let mut rows = Vec::new();
    for id in ids {
        match crate::services::finance::analysis(db, id, 5, false) {
            Ok(a) if a.get("available") == Some(&json!(true)) => {
                let kpi: std::collections::BTreeMap<String, Value> = a["kpi"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|k| k["available"] == json!(true))
                    .map(|k| (k["key"].as_str().unwrap_or("").to_string(), k["value"].clone()))
                    .collect();
                let pick = |k: &str| kpi.get(k).cloned().unwrap_or(Value::Null);
                let m = &a["models"];
                rows.push(json!({
                    "enterprise_id": id,
                    "name": a["enterprise"]["name"],
                    "industry": a["enterprise"]["industry"],
                    "available": true,
                    "latest_year": a["latest_year"],
                    "metrics": {
                        "revenue": pick("revenue"), "net_profit": pick("net_profit"),
                        "revenue_growth": pick("revenue_growth"), "gross_margin": pick("gross_margin"),
                        "net_margin": pick("net_margin"), "roe": pick("roe"),
                        "debt_ratio": pick("debt_ratio"), "ocf": pick("ocf"),
                        "ocf_to_profit": pick("ocf_to_profit"),
                    },
                    "models": {
                        "altman_z2": { "score": m["altman"]["z2"]["score"], "verdict": m["altman"]["z2"]["verdict"] },
                        "piotroski_f": { "score": m["piotroski"]["score"], "max_score": m["piotroski"]["max_score"] },
                        "beneish_m": { "score": m["beneish"]["score"], "verdict": m["beneish"]["verdict"] },
                    },
                    "anomaly_count": a["anomalies"].as_array().map(|x| x.len()).unwrap_or(0),
                }));
            }
            Ok(a) => rows.push(json!({
                "enterprise_id": id,
                "name": a["enterprise"]["name"],
                "available": false,
                "reason": a.get("reason").cloned().unwrap_or(json!("无数据")),
            })),
            Err(err) => rows.push(json!({ "enterprise_id": id, "available": false, "reason": err.to_string() })),
        }
    }
    json!({
        "count": rows.len(),
        "rows": rows,
        "hint": "数值单位见各指标：万元 / % / 倍；模型结论需结合数据完整度判断",
    })
}

/// 按财务指标筛选企业
pub fn screen_by_financial_metric(db: &Db, args: &Value) -> Value {
    let metric = arg_str(args, "metric");
    let op = {
        let o = arg_str(args, "op");
        if o.is_empty() { "lt".to_string() } else { o }
    };
    let value = args.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let limit = arg_i64(args, "limit", 10).clamp(1, 50);
    let supported = ["revenue", "net_profit", "revenue_growth", "gross_margin", "net_margin", "roe", "debt_ratio"];
    if !supported.contains(&metric.as_str()) {
        return json!({ "error": format!("不支持的指标：{metric}"), "supported": supported });
    }
    let ok = |v: f64| match op.as_str() {
        "lt" => v < value,
        "le" => v <= value,
        "gt" => v > value,
        "ge" => v >= value,
        _ => false,
    };
    if !["lt", "le", "gt", "ge"].contains(&op.as_str()) {
        return json!({ "error": format!("不支持的比较符：{op}"), "supported": ["lt", "le", "gt", "ge"] });
    }
    let data = match crate::services::finance::overview(db, 5) {
        Ok(v) => v,
        Err(err) => return json!({ "error": format!("筛选失败: {err}") }),
    };
    let items = data["items"].as_array().cloned().unwrap_or_default();
    let mut hits: Vec<Value> = items
        .iter()
        .filter_map(|it| {
            let v = it.get(&metric).and_then(|x| x.as_f64())?;
            if ok(v) {
                Some(json!({
                    "enterprise_id": it["enterprise_id"], "name": it["name"],
                    "industry": it["industry"], "year": it["latest_year"], "value": v,
                }))
            } else {
                None
            }
        })
        .collect();
    hits.sort_by(|a, b| {
        a["value"].as_f64().unwrap_or(0.0).partial_cmp(&b["value"].as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (label, unit, _g, _h) = crate::services::finance::METRIC_META
        .iter()
        .find(|(k, _, _, _, _)| *k == metric)
        .map(|(_, l, u, g, h)| (*l, *u, *g, *h))
        .unwrap_or(("", "", "", true));
    json!({
        "metric": metric, "metric_label": label, "unit": unit, "op": op, "threshold": value,
        "count": hits.len(),
        "items": hits.into_iter().take(limit as usize).collect::<Vec<_>>(),
        "scanned": items.len(),
    })
}

/// 需要网络或写库的异步工具（含手搓插件 `custom_*` 与 MCP `mcp_*`）
pub fn is_async_tool(name: &str) -> bool {
    matches!(
        name,
        "resolve_stock_code"
            | "add_enterprise"
            | "refresh_enterprise_data"
            | "handle_alert"
            | "run_risk_analysis"
    ) || name.starts_with("custom_")
        || name.starts_with("mcp_")
}

/// 异步工具分发（网络 + 写操作 + 插件 + MCP）
pub async fn call_tool_async(state: &crate::state::AppState, name: &str, args: &Value) -> Value {
    // 手搓插件（声明式 HTTP）
    if let Some(raw) = name.strip_prefix("custom_") {
        return match crate::services::presets::custom_tool_by_name(&state.db, raw) {
            Ok(Some(row)) => crate::services::presets::run_custom_tool(&row, args).await,
            Ok(None) => json!({ "error": format!("插件不存在或已停用：{raw}") }),
            Err(err) => json!({ "error": format!("插件查询失败: {err}") }),
        };
    }
    // MCP 外部工具：名称形如 mcp_{server_id}_{tool_name}
    if let Some(item) = crate::services::mcp::parse_tool_name(&state.db, name) {
        return crate::services::mcp::call_tool(&item.server_url, &item.auth_header, &item.name, args).await;
    }
    match name {
        "run_risk_analysis" => {
            let enterprise_id = arg_i64(args, "enterprise_id", 0);
            match crate::services::risk::analyze_enterprise(state, enterprise_id).await {
                Ok(v) => {
                    let verdict = v.get("verdict").cloned().unwrap_or(json!({}));
                    let evidence = verdict.get("evidence").and_then(|e| e.as_array()).cloned().unwrap_or_default();
                    json!({
                        "enterprise_id": enterprise_id,
                        "enterprise": v.get("enterprise").and_then(|e| e.get("name")),
                        "score": verdict.get("score"),
                        "grade": verdict.get("grade"),
                        "level": verdict.get("level"),
                        "llm_level": verdict.get("llm_level"),
                        "rules_level": verdict.get("rules_level"),
                        "cross_check_ok": verdict.get("cross_check_ok"),
                        "summary": verdict.get("summary"),
                        "evidence_count": evidence.len(),
                        "evidence": evidence.into_iter().take(8).collect::<Vec<_>>(),
                    })
                }
                Err(err) => json!({ "error": format!("研判失败: {err}") }),
            }
        }
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

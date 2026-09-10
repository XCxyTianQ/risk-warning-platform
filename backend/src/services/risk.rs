//! 风险研判服务（LLM 取数推理 + 规则交叉校验），对齐 Python 版 `app/services/risk.py`。
//!
//! 流程：
//!   1. LLM(带企业数据工具) → tool_calls → 执行工具并回注 → 再调用（至多 2 轮）
//!   2. LLM 输出严格 JSON 研判结论（level/维度/证据/综述）
//!   3. 规则引擎交叉校验（不一致标 mismatch，以规则为准）
//!   4. 证据写入 risk_fact（供前端展示与人工复核），并触发预警工单（闭环起点）

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};

use crate::db::Db;
use crate::llm::{LlmClient, LlmConfig};
use crate::services::rules;
use crate::state::AppState;
use crate::util::now_db;

pub const RISK_SYSTEM: &str = "你是企业经营风险研判分析师。你将获得企业的工商档案、财务、法律（涉诉/行政）、舆情数据。\
请先调用工具获取数据，再基于“六维评分规则”给出风险研判。\
六个维度：finance 财务健康、legal 法律合规、news 舆情声誉、operation 经营能力、\
credit 信用状况、supply 供应链稳定；每维度 0~100 分（越高越健康）。\
最终回复必须是一个严格的 JSON 对象，不要包含任何解释文字。JSON 格式：\n\
{\"level\":\"red|orange|yellow|green\",\"summary\":\"一句话结论\",\
\"dimensions\":{\"finance\":{\"level\":\"...\",\"score\":0-100,\"reason\":\"...\"},\
\"legal\":{\"...\":\"...\"},\"news\":{\"...\":\"...\"},\"operation\":{\"...\":\"...\"},\
\"credit\":{\"...\":\"...\"},\"supply\":{\"...\":\"...\"}},\
\"evidence\":[{\"dimension\":\"finance|legal|news|operation|credit|supply\",\"text\":\"事实描述\",\"source\":\"来源\",\"date\":\"YYYY-MM-DD\"}]}\n\
level 取值：red=高风险，orange=较高风险，yellow=关注，green=正常，gray=数据不足。\
证据必须逐条来自工具返回的数据，不得编造。";

/// 企业数据工具 schema（研判专用，与 Agent 工具集不同）
fn data_tool_schemas() -> Vec<Value> {
    let mk = |name: &str, desc: &str| {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": { "type": "object", "properties": {} },
            }
        })
    };
    vec![
        mk("get_entity_profile", "获取企业工商档案"),
        mk("get_finance_data", "获取企业财务指标（财报/资产负债/营收利润）"),
        mk("get_legal_records", "获取企业涉诉与司法/行政记录"),
        mk("get_news", "获取企业近期舆情新闻（含情感标签）"),
        mk("get_rules", "获取风险等级判定规则阈值（研判时参考）"),
    ]
}

fn enterprise_profile(db: &Db, enterprise_id: i64) -> Result<Value> {
    db.with(|conn| {
        let row = conn.query_row(
            "SELECT id, name, legal_rep, reg_capital_wan, reg_date, industry, address, data_note
             FROM enterprise WHERE id = ?1",
            [enterprise_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "legal_rep": r.get::<_, String>(2)?,
                    "reg_capital_wan": r.get::<_, f64>(3)?,
                    "reg_date": r.get::<_, String>(4)?,
                    "industry": r.get::<_, String>(5)?,
                    "address": r.get::<_, String>(6)?,
                    "data_note": r.get::<_, String>(7)?,
                }))
            },
        )?;
        Ok(row)
    })
}

/// 执行一个研判数据工具（只读，本地库）
fn call_data_tool(db: &Db, enterprise_id: i64, name: &str, profile: &Value) -> Value {
    match name {
        "get_entity_profile" => profile.clone(),
        "get_finance_data" => db
            .with(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT year, total_assets, total_liabilities, revenue, net_profit, debt_ratio, source
                     FROM finance WHERE enterprise_id = ?1 ORDER BY year",
                )?;
                let rows = stmt
                    .query_map([enterprise_id], |r| {
                        Ok(json!({
                            "year": r.get::<_, String>(0)?,
                            "total_assets": r.get::<_, f64>(1)?,
                            "total_liabilities": r.get::<_, f64>(2)?,
                            "revenue": r.get::<_, f64>(3)?,
                            "net_profit": r.get::<_, f64>(4)?,
                            "debt_ratio": r.get::<_, f64>(5)?,
                            "source": r.get::<_, String>(6)?,
                        }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map(|reports| {
                if reports.is_empty() {
                    json!({ "available": false, "note": "未上市企业，无公开财报（数据不足）", "enterprise": profile })
                } else {
                    json!({ "available": true, "reports": reports })
                }
            })
            .unwrap_or_else(|err| json!({ "error": err.to_string() })),
        "get_legal_records" => db
            .with(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT case_no, doc_type, title, court, cause, amount, status, judgment_date, source
                     FROM legal_record WHERE enterprise_id = ?1 ORDER BY judgment_date DESC",
                )?;
                let rows = stmt
                    .query_map([enterprise_id], |r| {
                        Ok(json!({
                            "case_no": r.get::<_, String>(0)?,
                            "doc_type": r.get::<_, String>(1)?,
                            "title": r.get::<_, String>(2)?,
                            "court": r.get::<_, String>(3)?,
                            "cause": r.get::<_, String>(4)?,
                            "amount": r.get::<_, f64>(5)?,
                            "status": r.get::<_, String>(6)?,
                            "date": r.get::<_, String>(7)?,
                            "source": r.get::<_, String>(8)?,
                        }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map(|records| {
                let total = records.len();
                json!({ "total": total, "records": records })
            })
            .unwrap_or_else(|err| json!({ "error": err.to_string() })),
        "get_news" => db
            .with(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT title, source, published_at, sentiment, url FROM news
                     WHERE enterprise_id = ?1 ORDER BY published_at DESC LIMIT 30",
                )?;
                let rows = stmt
                    .query_map([enterprise_id], |r| {
                        Ok(json!({
                            "title": r.get::<_, String>(0)?,
                            "source": r.get::<_, String>(1)?,
                            "date": r.get::<_, String>(2)?,
                            "sentiment": r.get::<_, String>(3)?,
                            "url": r.get::<_, String>(4)?,
                        }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map(|items| {
                let total = items.len();
                json!({ "total": total, "items": items })
            })
            .unwrap_or_else(|err| json!({ "error": err.to_string() })),
        "get_rules" => json!({
            "scoring": "每个维度 0~100 分（越高越健康）；综合评分 = 可用维度平均分；等级：≥85 正常(green)、70~84 关注(yellow)、55~69 较高风险(orange)、<55 高风险(red)、无数据 gray",
            "grades": { "AAA": "≥90 优秀", "AA": "80~89 良好", "A": "70~79 稳健", "BBB": "60~69 关注", "BB": "50~59 预警", "C": "<50 高风险" },
            "dimensions": {
                "finance": "资产负债率 ≥85% 或 净利润为负 → 扣分；连续亏损再扣分",
                "legal": "每条涉诉 -6（上限-50）；行政处罚 -10；刑事 -20；涉案 ≥1亿 -10",
                "news": "负面舆情占比 ×120 扣分（上限-60）；近一年负面每条 -3",
                "operation": "成立年限 + 净利润率 + 营收增速综合；净利润率为负 -30",
                "credit": "失信 -40/次；被执行 -30/次；行政处罚 -12/次",
                "supply": "合同类纠纷 -8/项；供应链负面舆情 -8/条"
            },
            "levels": { "red": "高风险", "orange": "较高风险", "yellow": "关注", "green": "正常", "gray": "数据不足" },
        }),
        other => json!({ "error": format!("unknown tool: {other}") }),
    }
}

/// 容忍 ```json 围栏 / 前后杂文的 JSON 提取
pub fn extract_json(text: &str) -> Option<Value> {
    let mut body = text.trim().to_string();
    if let Some(start) = body.find("```") {
        let after = &body[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            body = after[..end].to_string();
        }
    }
    let s = body.find('{')?;
    let e = body.rfind('}')?;
    if e <= s {
        return None;
    }
    serde_json::from_str::<Value>(&body[s..=e]).ok().filter(|v| v.is_object())
}

fn client_for(state: &AppState) -> LlmClient {
    let rt = state.rt();
    LlmClient::new(LlmConfig {
        base_url: rt.llm_base_url.clone(),
        api_key: rt.llm_api_key.clone(),
        model: rt.llm_model.clone(),
        max_tokens: rt.llm_analysis_max_tokens,
        timeout_s: 60,
        max_retries: 1,
        disable_thinking: rt.llm_disable_thinking,
    })
}

/// 带工具的取数 + 结论（至多两轮）
async fn run_llm_verdict(
    state: &AppState,
    db: &Db,
    enterprise_id: i64,
    name: &str,
    industry: &str,
) -> Result<(String, Option<Value>)> {
    let client = client_for(state);
    let profile = enterprise_profile(db, enterprise_id)?;
    let tools = data_tool_schemas();
    let mut messages = vec![
        json!({ "role": "system", "content": RISK_SYSTEM }),
        json!({
            "role": "user",
            "content": format!(
                "请对【{name}】（{}）进行经营风险研判，先调用工具获取数据，再输出结论 JSON。JSON 必须完整，evidence 最多 8 条。",
                if industry.is_empty() { "工商注册中" } else { industry }
            ),
        }),
    ];

    let mut final_text = String::new();
    for _ in 0..2 {
        let msg = client
            .chat(messages.clone(), tools.clone(), None)
            .await
            .map_err(|e| anyhow!(e.to_string()))?;
        let calls = msg.get("tool_calls").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if !calls.is_empty() {
            messages.push(json!({
                "role": "assistant",
                "content": msg.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                "tool_calls": calls,
            }));
            for tc in calls {
                let fnv = tc.get("function").cloned().unwrap_or(json!({}));
                let tool_name = fnv.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let result = call_data_tool(db, enterprise_id, tool_name, &profile);
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "content": serde_json::to_string(&result).unwrap_or_else(|_| "{}".into()),
                }));
            }
            continue;
        }
        final_text = msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        break;
    }

    let mut verdict = extract_json(&final_text);
    // 输出被截断/夹杂解释时，补一次"只输出完整 JSON"的重试
    if verdict.is_none() {
        messages.push(json!({ "role": "assistant", "content": final_text }));
        messages.push(json!({
            "role": "user",
            "content": "上面的输出不是完整 JSON。请只输出一个完整 JSON 对象（不要任何解释），字段 level/summary/dimensions/evidence，evidence 最多 6 条、每条不超过 60 字。",
        }));
        if let Ok(retry) = client.chat(messages.clone(), vec![], None).await {
            if let Some(text) = retry.get("content").and_then(|v| v.as_str()) {
                final_text = text.to_string();
                verdict = extract_json(text);
            }
        }
    }
    Ok((final_text, verdict))
}

/// 完整研判：LLM + 规则交叉校验 + 证据落库 + 预警闭环
pub async fn analyze_enterprise(state: &AppState, enterprise_id: i64) -> Result<Value> {
    let db = &state.db;
    let ent = db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, name, legal_rep, reg_date, industry, data_note FROM enterprise WHERE id = ?1",
                [enterprise_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "legal_rep": r.get::<_, String>(2)?,
                        "reg_date": r.get::<_, String>(3)?,
                        "industry": r.get::<_, String>(4)?,
                        "data_note": r.get::<_, String>(5)?,
                    }))
                },
            )
            .map_err(|e| anyhow!("企业不存在: {enterprise_id} ({e})"))?;
        Ok(row)
    })?;
    let name = ent.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let industry = ent.get("industry").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let (raw_text, llm_verdict) = run_llm_verdict(state, db, enterprise_id, &name, &industry).await?;

    let rules = rules::rules_verdict(db, enterprise_id)?;
    let llm_level_raw = llm_verdict
        .as_ref()
        .and_then(|v| v.get("level"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let llm_level = if matches!(llm_level_raw.as_str(), "red" | "orange" | "yellow" | "green") {
        llm_level_raw.clone()
    } else {
        "unknown".to_string()
    };
    let cross_check = llm_level == rules.level;
    let final_level = rules.level.clone();

    // 证据落库 risk_fact
    let evidence = llm_verdict
        .as_ref()
        .and_then(|v| v.get("evidence"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if !evidence.is_empty() {
        let ts = now_db();
        db.with(|conn| {
            for ev in &evidence {
                let dim: String = ev
                    .get("dimension")
                    .and_then(|v| v.as_str())
                    .unwrap_or("other")
                    .chars()
                    .take(30)
                    .collect();
                let text: String = ev
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(1000)
                    .collect();
                let source = ev.get("source").and_then(|v| v.as_str()).unwrap_or("");
                let date = ev.get("date").and_then(|v| v.as_str()).unwrap_or("");
                conn.execute(
                    "INSERT INTO risk_fact (enterprise_id, dimension, text, evidence_json, confidence, ts)
                     VALUES (?1, ?2, ?3, ?4, 0.8, ?5)",
                    params![
                        enterprise_id,
                        dim,
                        text,
                        json!({ "source": source, "date": date }).to_string(),
                        ts,
                    ],
                )?;
            }
            Ok(())
        })?;
    }

    // 研判完成 → 触发预警工单（闭环起点；失败不影响研判结果）
    let _ = crate::services::alerts::generate_for_enterprise(db, enterprise_id, "analysis");

    let summary = llm_verdict
        .as_ref()
        .and_then(|v| v.get("summary"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| raw_text.chars().take(500).collect());

    let dims = serde_json::to_value(&rules.dimensions).unwrap_or(json!({}));
    Ok(json!({
        "enterprise": ent,
        "verdict": {
            "level": final_level,
            "score": rules.score,
            "grade": rules.grade,
            "grade_label": rules.grade_label,
            "level_by": if cross_check { "llm" } else { "rules" },
            "cross_check_ok": cross_check,
            "llm_level": llm_level,
            "rules_level": rules.level,
            "dimensions": dims,
            "summary": summary,
            "evidence": evidence,
        },
    }))
}

/// 读侧快照：风险事实 + 指标（不触发 LLM 调用，页面刷新用）
pub fn risk_snapshot(db: &Db, enterprise_id: i64) -> Result<Value> {
    let ent = db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, name FROM enterprise WHERE id = ?1",
                [enterprise_id],
                |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)? })),
            )
            .map_err(|e| anyhow!("企业不存在: {enterprise_id} ({e})"))?;
        Ok(row)
    })?;
    let rules = rules::rules_verdict(db, enterprise_id)?;
    let facts = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT dimension, text, evidence_json, confidence, ts FROM risk_fact
             WHERE enterprise_id = ?1 ORDER BY ts DESC LIMIT 50",
        )?;
        let rows = stmt
            .query_map([enterprise_id], |r| {
                let evidence: String = r.get(2)?;
                Ok(json!({
                    "dimension": r.get::<_, String>(0)?,
                    "text": r.get::<_, String>(1)?,
                    "evidence": serde_json::from_str::<Value>(&evidence).unwrap_or_else(|_| json!({})),
                    "confidence": r.get::<_, f64>(3)?,
                    "ts": crate::util::db_to_iso(&r.get::<_, String>(4)?),
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    Ok(json!({
        "enterprise": ent,
        "verdict_level": rules.level,
        "score": rules.score,
        "grade": rules.grade,
        "grade_label": rules.grade_label,
        "dimensions": serde_json::to_value(&rules.dimensions).unwrap_or(json!({})),
        "facts": facts,
    }))
}

/// 风险事实列表（/api/risk-facts）
pub fn list_risk_facts(
    db: &Db,
    dimension: Option<&str>,
    enterprise_id: Option<i64>,
    limit: i64,
) -> Result<Value> {
    let rows = db.with(|conn| {
        let mut sql = String::from(
            "SELECT f.id, f.enterprise_id, e.name, f.dimension, f.text, f.confidence, f.ts
             FROM risk_fact f JOIN enterprise e ON e.id = f.enterprise_id WHERE 1 = 1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(dim) = dimension {
            sql.push_str(" AND f.dimension = ?");
            args.push(Box::new(dim.to_string()));
        }
        if let Some(id) = enterprise_id {
            sql.push_str(" AND f.enterprise_id = ?");
            args.push(Box::new(id));
        }
        sql.push_str(" ORDER BY f.ts DESC LIMIT ?");
        args.push(Box::new(limit.clamp(1, 500)));
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(params.as_slice(), |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "enterprise_id": r.get::<_, i64>(1)?,
                    "enterprise": r.get::<_, String>(2)?,
                    "dimension": r.get::<_, String>(3)?,
                    "dimension_label": rules::dim_label(&r.get::<_, String>(3)?),
                    "text": r.get::<_, String>(4)?,
                    "confidence": r.get::<_, f64>(5)?,
                    "ts": crate::util::db_to_iso(&r.get::<_, String>(6)?),
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": rows.len(), "items": rows }))
}

/// 按名称或股票代码定位企业并发起研判
pub async fn analyze_by_name(state: &AppState, raw: &str) -> Result<Value> {
    let raw = raw.trim().to_string();
    let code = crate::util::normalize_code(&raw);
    let ent_id: Option<i64> = state.db.with(|conn| {
        let mut id: Option<i64> = None;
        if let Some(code) = &code {
            id = conn
                .query_row("SELECT id FROM enterprise WHERE stock_code = ?1", [code], |r| r.get(0))
                .ok();
        }
        if id.is_none() {
            id = conn
                .query_row(
                    "SELECT id FROM enterprise WHERE instr(name, ?1) > 0 ORDER BY id LIMIT 1",
                    [&raw],
                    |r| r.get(0),
                )
                .ok();
        }
        if id.is_none() {
            id = conn
                .query_row("SELECT id FROM enterprise WHERE name = ?1", [&raw], |r| r.get(0))
                .ok();
        }
        Ok(id)
    })?;

    let Some(id) = ent_id else {
        return Ok(json!({
            "error": format!("企业不存在：{raw}"),
            "not_found": true,
        }));
    };
    analyze_enterprise(state, id).await
}

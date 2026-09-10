//! 预警中心：生成 / 列表 / 处置流转 / 报告导出（与 Python 版 `app/services/alerts.py` 对齐）。
//!
//! 闭环：数据刷新或研判 → 评分触发预警 → 人工处置（待处理→处理中→已处置/已忽略）→ 流水留痕。

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::db::Db;
use crate::services::rules::{dim_label, rules_verdict};

const LEVEL_BY_SCORE: [(f64, &str); 3] = [(55.0, "red"), (70.0, "orange"), (85.0, "yellow")];
const OPEN_STATUS: [&str; 2] = ["pending", "handling"];

pub fn status_label(status: &str) -> String {
    match status {
        "pending" => "待处理",
        "handling" => "处理中",
        "resolved" => "已处置",
        "ignored" => "已忽略",
        other => other,
    }
    .to_string()
}

fn level_of(score: Option<f64>) -> Option<&'static str> {
    let s = score?;
    for (threshold, level) in LEVEL_BY_SCORE {
        if s < threshold {
            return Some(level);
        }
    }
    None
}

fn dimension_label(dim: &str) -> String {
    if dim == "overall" {
        "综合".into()
    } else {
        dim_label(dim).to_string()
    }
}

/// 按当前评分生成预警（幂等：同企业+维度+等级存在未关闭工单则跳过）
pub fn generate_for_enterprise(db: &Db, enterprise_id: i64, source: &str) -> Result<Value> {
    let ent_name: String = db.with(|conn| {
        Ok(conn
            .query_row("SELECT name FROM enterprise WHERE id = ?1", [enterprise_id], |r| r.get(0))
            .unwrap_or_default())
    })?;
    if ent_name.is_empty() {
        return Ok(json!({ "error": format!("企业不存在: {enterprise_id}") }));
    }
    let verdict = rules_verdict(db, enterprise_id)?;
    let now = crate::util::now_db();

    let mut created: Vec<Value> = Vec::new();
    let mut skipped = 0i64;

    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let create = |level: &str,
                          dimension: &str,
                          title: String,
                          summary: String,
                          score: Option<f64>,
                          evidence: Value,
                          skipped: &mut i64,
                          created: &mut Vec<Value>|
         -> Result<()> {
            let fp = format!("{enterprise_id}:{dimension}:{level}");
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM alert WHERE fingerprint = ?1 AND status IN (?2, ?3)",
                rusqlite::params![fp, OPEN_STATUS[0], OPEN_STATUS[1]],
                |r| r.get(0),
            )?;
            if exists > 0 {
                *skipped += 1;
                return Ok(());
            }
            tx.execute(
                "INSERT INTO alert
                 (enterprise_id, level, dimension, title, summary, evidence_json, score,
                  status, source, fingerprint, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?10)",
                rusqlite::params![
                    enterprise_id,
                    level,
                    dimension,
                    title,
                    summary,
                    evidence.to_string(),
                    score,
                    source,
                    fp,
                    now
                ],
            )?;
            created.push(json!({
                "level": level,
                "dimension": dimension,
                "title": title,
                "score": score,
            }));
            Ok(())
        };

        for dim in crate::services::rules::DIMS {
            let Some(info) = verdict.dimensions.get(dim) else { continue };
            let Some(level) = level_of(info.score.map(|s| s as f64)) else { continue };

            // 证据：优先取 LLM 事实，无事实时用规则指标说明
            let mut evidence: Vec<Value> = Vec::new();
            let mut stmt = tx.prepare(
                "SELECT text, evidence_json FROM risk_fact
                 WHERE enterprise_id = ?1 AND dimension = ?2 ORDER BY ts DESC LIMIT 3",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![enterprise_id, dim], |r| {
                    let text: String = r.get(0)?;
                    let raw: String = r.get(1)?;
                    Ok((text, raw))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (text, raw) in rows {
                let src = serde_json::from_str::<Value>(&raw)
                    .ok()
                    .and_then(|v| v.get("source").and_then(|s| s.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default();
                evidence.push(json!({ "text": text, "source": src }));
            }
            if evidence.is_empty() {
                evidence.push(json!({ "text": info.note, "source": "规则引擎指标" }));
            }

            create(
                level,
                dim,
                format!("{}风险预警（{} 分）", info.label, info.score.unwrap_or(0)),
                info.note.clone(),
                info.score.map(|s| s as f64),
                json!(evidence),
                &mut skipped,
                &mut created,
            )?;
        }

        if verdict.level == "red" || verdict.level == "orange" {
            let dims: Vec<Value> = verdict
                .dimensions
                .iter()
                .filter(|(_, v)| v.score.is_some())
                .map(|(d, v)| json!({ "dimension": d, "score": v.score, "note": v.note }))
                .collect();
            create(
                &verdict.level,
                "overall",
                format!(
                    "综合风险预警：{}（{} 分 / {}）",
                    ent_name,
                    verdict.score.map(|s| s.to_string()).unwrap_or_else(|| "—".into()),
                    verdict.grade
                ),
                format!("六维综合评级 {}（{}），建议按预警流程核查处置。", verdict.grade, verdict.grade_label),
                verdict.score,
                json!(dims),
                &mut skipped,
                &mut created,
            )?;
        }

        tx.commit()?;
        Ok(())
    })?;

    Ok(json!({
        "enterprise_id": enterprise_id,
        "enterprise": ent_name,
        "created": created,
        "skipped": skipped,
    }))
}

/// 全库生成
pub fn generate_all(db: &Db, source: &str) -> Result<Value> {
    let ids: Vec<(i64, String)> = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT id, name FROM enterprise ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut created_total = 0i64;
    let mut skipped_total = 0i64;
    let mut details: Vec<Value> = Vec::new();
    for (id, name) in &ids {
        let r = generate_for_enterprise(db, *id, source)?;
        let created = r.get("created").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) as i64;
        created_total += created;
        skipped_total += r.get("skipped").and_then(|v| v.as_i64()).unwrap_or(0);
        if created > 0 {
            details.push(json!({ "enterprise": name, "created": created }));
        }
    }
    Ok(json!({
        "enterprises": ids.len(),
        "created": created_total,
        "skipped": skipped_total,
        "details": details,
    }))
}

/// 预警列表
pub fn list_alerts(
    db: &Db,
    status: Option<&str>,
    level: Option<&str>,
    enterprise_id: Option<i64>,
    limit: i64,
) -> Result<Value> {
    let rows = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.enterprise_id, e.name, a.level, a.dimension, a.title, a.summary,
                    a.score, a.status, a.handler, a.created_at, a.updated_at, a.handled_at,
                    a.notes_json, a.evidence_json
             FROM alert a JOIN enterprise e ON e.id = a.enterprise_id
             WHERE (?1 = '' OR a.status = ?1) AND (?2 = '' OR a.level = ?2)
               AND (?3 = 0 OR a.enterprise_id = ?3)
             ORDER BY a.created_at DESC LIMIT ?4",
        )?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    status.unwrap_or(""),
                    level.unwrap_or(""),
                    enterprise_id.unwrap_or(0),
                    limit
                ],
                |r| {
                    let notes: String = r.get(13)?;
                    let evidence: String = r.get(14)?;
                    let status: String = r.get(8)?;
                    let dimension: String = r.get(4)?;
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "enterprise_id": r.get::<_, i64>(1)?,
                        "enterprise": r.get::<_, String>(2)?,
                        "level": r.get::<_, String>(3)?,
                        "dimension": dimension,
                        "dimension_label": dimension_label(&r.get::<_, String>(4)?),
                        "title": r.get::<_, String>(5)?,
                        "summary": r.get::<_, String>(6)?,
                        "score": r.get::<_, Option<f64>>(7)?,
                        "status_label": status_label(&status),
                        "status": status,
                        "handler": r.get::<_, String>(9)?,
                        "created_at": crate::util::db_to_iso(&r.get::<_, String>(10)?),
                        "updated_at": crate::util::db_to_iso(&r.get::<_, String>(11)?),
                        "handled_at": crate::util::opt_db_to_iso(r.get::<_, Option<String>>(12)?),
                        "notes": serde_json::from_str::<Value>(&notes).unwrap_or(json!([])),
                        "evidence": serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),
                    }))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": rows.len(), "items": rows }))
}

/// 统计
pub fn summary(db: &Db) -> Result<Value> {
    let rows: Vec<(String, String)> = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT status, level FROM alert")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut by_status: Map<String, Value> = Map::new();
    let mut by_level: Map<String, Value> = Map::new();
    for (status, level) in &rows {
        let c = by_status.get(status).and_then(|v| v.as_i64()).unwrap_or(0);
        by_status.insert(status.clone(), json!(c + 1));
        let c = by_level.get(level).and_then(|v| v.as_i64()).unwrap_or(0);
        by_level.insert(level.clone(), json!(c + 1));
    }
    let pending = by_status.get("pending").and_then(|v| v.as_i64()).unwrap_or(0);
    let handling = by_status.get("handling").and_then(|v| v.as_i64()).unwrap_or(0);
    for key in ["pending", "handling", "resolved", "ignored"] {
        by_status.entry(key.to_string()).or_insert(json!(0));
    }
    Ok(json!({
        "total": rows.len(),
        "by_status": by_status,
        "by_level": by_level,
        "pending": pending,
        "handling": handling,
    }))
}

/// 处置流转：start / resolve / ignore / reopen
pub fn handle_alert(db: &Db, alert_id: i64, action: &str, handler: &str, note: &str) -> Result<Value> {
    let current: Option<String> = db.with(|conn| {
        let r = conn.query_row("SELECT status FROM alert WHERE id = ?1", [alert_id], |r| r.get(0));
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    let Some(current_status) = current else {
        return Ok(json!({ "error": format!("预警不存在: {alert_id}") }));
    };

    let (new_status, allowed): (&str, &[&str]) = match action {
        "start" => ("handling", &["pending", "handling", "ignored", "resolved"]),
        "resolve" => ("resolved", &["pending", "handling"]),
        "ignore" => ("ignored", &["pending", "handling"]),
        "reopen" => ("pending", &["resolved", "ignored"]),
        other => {
            return Ok(json!({
                "error": format!("不支持的动作: {other}（可选 start/resolve/ignore/reopen）"),
            }))
        }
    };
    if !allowed.contains(&current_status.as_str()) {
        return Ok(json!({
            "error": format!("当前状态「{}」不能执行 {action}", status_label(&current_status)),
        }));
    }

    let now = crate::util::now_db();
    let notes = db.with(|conn| {
        let raw: String = conn
            .query_row("SELECT notes_json FROM alert WHERE id = ?1", [alert_id], |r| r.get(0))
            .unwrap_or_else(|_| "[]".into());
        let mut notes: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
        notes.push(json!({
            "ts": crate::util::db_to_iso(&now),
            "action": action,
            "status": new_status,
            "status_label": status_label(new_status),
            "handler": handler,
            "note": note,
        }));
        let handler_value = if handler.is_empty() {
            conn.query_row("SELECT handler FROM alert WHERE id = ?1", [alert_id], |r| r.get::<_, String>(0))
                .unwrap_or_default()
        } else {
            handler.to_string()
        };
        conn.execute(
            "UPDATE alert SET status = ?1, handler = ?2, updated_at = ?3,
                    handled_at = CASE WHEN ?1 IN ('resolved','ignored') THEN ?3 ELSE handled_at END,
                    notes_json = ?4
             WHERE id = ?5",
            rusqlite::params![new_status, handler_value, now, serde_json::to_string(&notes)?, alert_id],
        )?;
        Ok(notes)
    })?;

    Ok(json!({
        "alert_id": alert_id,
        "status": new_status,
        "status_label": status_label(new_status),
        "notes": notes,
    }))
}

/// 预警报告（Markdown）
pub fn report_markdown(db: &Db, alert_id: i64) -> Result<String> {
    let row = db.with(|conn| {
        let r = conn.query_row(
            "SELECT a.id, a.enterprise_id, e.name, a.level, a.dimension, a.title, a.summary,
                    a.score, a.status, a.handler, a.created_at, a.evidence_json, a.notes_json
             FROM alert a JOIN enterprise e ON e.id = a.enterprise_id WHERE a.id = ?1",
            [alert_id],
            |r| {
                Ok((
                    r.get::<_, String>(2)?,   // enterprise name
                    r.get::<_, String>(3)?,   // level
                    r.get::<_, String>(4)?,   // dimension
                    r.get::<_, String>(5)?,   // title
                    r.get::<_, String>(6)?,   // summary
                    r.get::<_, Option<f64>>(7)?,
                    r.get::<_, String>(8)?,   // status
                    r.get::<_, String>(9)?,   // handler
                    r.get::<_, String>(10)?,  // created_at
                    r.get::<_, String>(11)?,  // evidence
                    r.get::<_, String>(12)?,  // notes
                ))
            },
        );
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    let Some((ent_name, level, dimension, title, summary, score, status, handler, created_at, evidence_raw, notes_raw)) = row
    else {
        return Ok(String::new());
    };
    let evidence: Vec<Value> = serde_json::from_str(&evidence_raw).unwrap_or_default();
    let notes: Vec<Value> = serde_json::from_str(&notes_raw).unwrap_or_default();

    let mut lines = vec![
        "# 企业经营风险预警报告".to_string(),
        String::new(),
        format!("- **企业**：{ent_name}"),
        format!("- **预警等级**：{level} · {title}"),
        format!("- **维度**：{}", dimension_label(&dimension)),
        format!(
            "- **评分**：{}",
            score.map(|s| s.to_string()).unwrap_or_else(|| "—".into())
        ),
        format!("- **状态**：{}｜处理人：{}", status_label(&status), if handler.is_empty() { "—" } else { &handler }),
        format!("- **生成时间**：{}", crate::util::db_to_iso(&created_at)),
        "- **数据来源**：公开信源（东方财富 / 新浪财经 / 巨潮资讯，直连接口）".to_string(),
        String::new(),
        "## 预警摘要".to_string(),
        String::new(),
        if summary.is_empty() { "（无）".into() } else { summary },
        String::new(),
        "## 证据链".to_string(),
        String::new(),
    ];
    if evidence.is_empty() {
        lines.push("（暂无证据记录，建议重新研判或刷新数据）".into());
    } else {
        for (i, ev) in evidence.iter().enumerate() {
            let text = ev
                .get("text")
                .or_else(|| ev.get("note"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| ev.to_string());
            let src = ev
                .get("source")
                .or_else(|| ev.get("dimension"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            lines.push(format!(
                "{}. {}{}",
                i + 1,
                text,
                if src.is_empty() { String::new() } else { format!("（来源：{src}）") }
            ));
        }
    }
    lines.extend([String::new(), "## 处置流水".to_string(), String::new()]);
    if notes.is_empty() {
        lines.push("（尚未处置）".into());
    } else {
        for n in &notes {
            let ts = n.get("ts").and_then(|v| v.as_str()).unwrap_or("");
            lines.push(format!(
                "- {} · {} · {} · {}",
                ts.chars().take(19).collect::<String>(),
                n.get("status_label").and_then(|v| v.as_str()).unwrap_or(""),
                n.get("handler").and_then(|v| v.as_str()).unwrap_or(""),
                n.get("note").and_then(|v| v.as_str()).unwrap_or(""),
            ));
        }
    }
    lines.extend([
        String::new(),
        "---".into(),
        String::new(),
        "> 本报告由「企业经营风险预警平台」自动生成，数据来自公开信源，不构成投资建议。".into(),
    ]);
    Ok(lines.join("\n"))
}

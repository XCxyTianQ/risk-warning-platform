//! 风险总览接口（前端 Dashboard 使用）：企业评分分布 + 维度分布 + 风险事实 + 舆情情感。

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::error::AppResult;
use crate::services::rules;
use crate::state::AppState;

/// GET /api/dashboard/summary
pub async fn summary(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let rows: Vec<(i64, String, String, String)> = st.db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, industry, stock_code FROM enterprise ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let mut level_counts: std::collections::BTreeMap<String, i64> = Default::default();
    let mut dimension_levels: std::collections::BTreeMap<String, std::collections::BTreeMap<String, i64>> =
        Default::default();
    let mut scores: Vec<f64> = Vec::new();
    let mut enterprises: Vec<Value> = Vec::new();

    for (id, name, industry, stock_code) in &rows {
        let Ok(v) = rules::rules_verdict(&st.db, *id) else { continue };
        *level_counts.entry(v.level.clone()).or_insert(0) += 1;
        if let Some(s) = v.score {
            scores.push(s);
        }
        let mut dimensions = serde_json::Map::new();
        let mut dimension_scores = serde_json::Map::new();
        for (dim, dv) in &v.dimensions {
            dimensions.insert(dim.clone(), json!(dv.level));
            dimension_scores.insert(dim.clone(), json!(dv.score));
            let entry = dimension_levels.entry(dim.clone()).or_default();
            *entry.entry(dv.level.clone()).or_insert(0) += 1;
        }
        enterprises.push(json!({
            "id": id,
            "name": name,
            "stock_code": stock_code,
            "industry": industry,
            "level": v.level,
            "score": v.score,
            "grade": v.grade,
            "grade_label": v.grade_label,
            "dimensions": dimensions,
            "dimension_scores": dimension_scores,
            "indicators": v.indicators,
        }));
    }

    let avg = if scores.is_empty() {
        Value::Null
    } else {
        json!(((scores.iter().sum::<f64>() / scores.len() as f64) * 10.0).round() / 10.0)
    };

    let (fact_total, recent_facts) = st.db.with(|conn| {
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM risk_fact", [], |r| r.get(0))?;
        let mut stmt = conn.prepare(
            "SELECT f.dimension, f.text, f.ts, e.name FROM risk_fact f
             JOIN enterprise e ON e.id = f.enterprise_id ORDER BY f.ts DESC LIMIT 12",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(json!({
                    "enterprise": r.get::<_, String>(3)?,
                    "dimension": r.get::<_, String>(0)?,
                    "text": r.get::<_, String>(1)?,
                    "ts": r.get::<_, String>(2)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((total, rows))
    })?;

    let news_sentiment: std::collections::BTreeMap<String, i64> = st
        .db
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT sentiment, COUNT(*) FROM news GROUP BY sentiment")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?
        .into_iter()
        .collect();

    Ok(Json(json!({
        "enterprise_total": rows.len(),
        "avg_score": avg,
        "level_counts": level_counts,
        "dimension_levels": dimension_levels,
        "enterprises": enterprises,
        "fact_total": fact_total,
        "recent_facts": recent_facts,
        "news_sentiment": news_sentiment,
    })))
}

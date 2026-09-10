//! 六维企业评分引擎（与 Python 版 `app/services/rules.py` 逐条对齐）。
//!
//! 设计：
//! - 每维输出 0~100（越高越健康）与等级；数据不足的维度输出 null + gray，不参与综合评分；
//! - 综合评分 = 可用维度算术平均，映射 AAA~C；
//! - "没有数据 ≠ 没有风险"：never/error 维度不参与评分。

use std::collections::BTreeMap;

use anyhow::Result;
use chrono::NaiveDate;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Db;

pub const DIMS: [&str; 6] = ["finance", "legal", "news", "operation", "credit", "supply"];

pub fn dim_label(dim: &str) -> &'static str {
    match dim {
        "finance" => "财务健康",
        "legal" => "法律合规",
        "news" => "舆情声誉",
        "operation" => "经营能力",
        "credit" => "信用状况",
        "supply" => "供应链稳定",
        _ => "未知维度",
    }
}

const GRADE_TABLE: [(f64, &str, &str); 6] = [
    (90.0, "AAA", "优秀"),
    (80.0, "AA", "良好"),
    (70.0, "A", "稳健"),
    (60.0, "BBB", "关注"),
    (50.0, "BB", "预警"),
    (0.0, "C", "高风险"),
];

const SUPPLY_KEYWORDS: [&str; 6] = ["合同", "买卖", "运输", "采购", "供货", "交付"];
const SUPPLY_NEWS_KEYWORDS: [&str; 5] = ["供应商", "断供", "交付", "产能", "供应链"];

pub fn clamp_score(v: f64) -> i64 {
    v.round().clamp(0.0, 100.0) as i64
}

pub fn score_to_level(score: Option<i64>) -> &'static str {
    match score {
        None => "gray",
        Some(s) if s >= 85 => "green",
        Some(s) if s >= 70 => "yellow",
        Some(s) if s >= 55 => "orange",
        Some(_) => "red",
    }
}

pub fn grade_of(score: Option<f64>) -> (String, String) {
    let Some(s) = score else {
        return ("—".into(), "数据不足".into());
    };
    for (threshold, grade, label) in GRADE_TABLE {
        if s >= threshold {
            return (grade.into(), label.into());
        }
    }
    ("C".into(), "高风险".into())
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.len() >= 10 {
        if let Ok(d) = NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
            return Some(d);
        }
    }
    if s.len() == 7 {
        if let Ok(d) = NaiveDate::parse_from_str(&format!("{s}-01"), "%Y-%m-%d") {
            return Some(d);
        }
    }
    None
}

fn age_years(reg_date: &str) -> Option<i64> {
    let d = parse_date(reg_date)?;
    let days = (chrono::Local::now().date_naive() - d).num_days();
    Some((days / 365).max(0))
}

fn num_of(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 汇总原始信号（对应 Python 的 compute_indicators）
pub fn compute_indicators(db: &Db, enterprise_id: i64) -> Result<Value> {
    db.with(|conn| {
        let (reg_date, data_status): (String, String) = conn
            .query_row(
                "SELECT reg_date, data_status_json FROM enterprise WHERE id = ?1",
                [enterprise_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_default();
        let data_status: Value = serde_json::from_str(&data_status).unwrap_or(json!({}));

        // ---- 财务 ----
        let mut stmt = conn.prepare(
            "SELECT year, revenue, net_profit, debt_ratio, source FROM finance
             WHERE enterprise_id = ?1 ORDER BY year DESC",
        )?;
        let rows: Vec<(String, f64, f64, f64, String)> = stmt
            .query_map([enterprise_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let finance = if rows.is_empty() {
            json!({ "available": false, "note": "未上市/无公开财报（数据不足）" })
        } else {
            let latest = &rows[0];
            let growth = rows.get(1).and_then(|prev| {
                if prev.1 != 0.0 {
                    Some((((latest.1 - prev.1) / prev.1.abs()) * 1000.0).round() / 10.0)
                } else {
                    None
                }
            });
            let margin = if latest.1 != 0.0 {
                Some(((latest.2 / latest.1) * 1000.0).round() / 10.0)
            } else {
                None
            };
            let loss_years = rows.iter().filter(|r| r.2 < 0.0).count();
            json!({
                "available": true,
                "year": latest.0,
                "debt_ratio": latest.3,
                "net_profit": latest.2,
                "revenue": latest.1,
                "revenue_growth": growth,
                "net_margin": margin,
                "source": latest.4,
                "loss_years": loss_years,
            })
        };

        // ---- 法律 / 信用 / 供应链（同源） ----
        let mut stmt = conn.prepare(
            "SELECT doc_type, title, status, cause, amount FROM legal_record WHERE enterprise_id = ?1",
        )?;
        let legal_rows: Vec<(String, String, String, String, f64)> = stmt
            .query_map([enterprise_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let (mut shixin, mut zhixing, mut penalty, mut criminal, mut contract_disputes, mut trademark_admin) =
            (0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
        let mut legal_amount = 0.0f64;
        for (doc_type, title, status, cause, amount) in &legal_rows {
            let text = format!("{doc_type} {title} {status} {cause}");
            if text.contains("失信") {
                shixin += 1;
            }
            if text.contains("被执行") {
                zhixing += 1;
            }
            if text.contains("行政处罚") || doc_type.contains("处罚") {
                penalty += 1;
            }
            if doc_type.contains("刑事") {
                criminal += 1;
            }
            if SUPPLY_KEYWORDS.iter().any(|k| cause.contains(k)) {
                contract_disputes += 1;
            }
            if text.contains("商标") {
                trademark_admin += 1;
            }
            legal_amount += amount;
        }

        // ---- 舆情 ----
        let mut stmt = conn.prepare("SELECT title, sentiment, published_at FROM news WHERE enterprise_id = ?1")?;
        let news_rows: Vec<(String, String, String)> = stmt
            .query_map([enterprise_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        let news_total = news_rows.len() as i64;
        let news_negative = news_rows.iter().filter(|n| n.1 == "negative").count() as i64;
        let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(365);
        let recent_negative = news_rows
            .iter()
            .filter(|n| n.1 == "negative" && parse_date(&n.2).map(|d| d >= cutoff).unwrap_or(false))
            .count() as i64;
        let supply_news_negative = news_rows
            .iter()
            .filter(|n| n.1 == "negative" && SUPPLY_NEWS_KEYWORDS.iter().any(|k| n.0.contains(k)))
            .count() as i64;
        let negative_ratio = if news_total > 0 {
            ((news_negative as f64 / news_total as f64) * 1000.0).round() / 1000.0
        } else {
            0.0
        };

        let operation = json!({
            "age_years": age_years(&reg_date),
            "revenue_growth": finance.get("revenue_growth").cloned().unwrap_or(Value::Null),
            "net_margin": finance.get("net_margin").cloned().unwrap_or(Value::Null),
        });

        Ok(json!({
            "data_status": data_status,
            "finance": finance,
            "legal": {
                "count": legal_rows.len(),
                "amount": legal_amount,
                "penalty": penalty,
                "criminal": criminal,
                "trademark_admin": trademark_admin,
            },
            "news": {
                "total": news_total,
                "negative": news_negative,
                "negative_ratio": negative_ratio,
                "recent_negative": recent_negative,
            },
            "operation": operation,
            "credit": { "shixin": shixin, "zhixing": zhixing, "penalty": penalty },
            "supply": { "contract_disputes": contract_disputes, "supply_news_negative": supply_news_negative },
        }))
    })
}

fn status_of(ind: &Value, dim: &str) -> String {
    ind.get("data_status")
        .and_then(|v| v.get(dim))
        .and_then(|v| v.as_str())
        .unwrap_or("never")
        .to_string()
}

/// 单维评分 → (score, note)
pub fn dim_score(dim: &str, ind: &Value) -> (Option<i64>, String) {
    match dim {
        "finance" => {
            let fin = &ind["finance"];
            if status_of(ind, "finance") != "ok" || fin.get("available").and_then(|v| v.as_bool()) != Some(true) {
                return (None, "无公开财报数据（未采集或数据不足）".into());
            }
            let mut s = 100.0f64;
            let debt = num_of(fin, "debt_ratio");
            if debt >= 85.0 {
                s -= 45.0;
            } else if debt >= 70.0 {
                s -= 30.0;
            } else if debt >= 60.0 {
                s -= 15.0;
            }
            if num_of(fin, "net_profit") < 0.0 {
                s -= 25.0;
            }
            if num_of(fin, "loss_years") >= 2.0 {
                s -= 10.0;
            }
            (
                Some(clamp_score(s)),
                format!(
                    "资产负债率 {}% · 净利润 {} 万（{}）",
                    debt,
                    num_of(fin, "net_profit"),
                    str_of(fin, "year")
                ),
            )
        }
        "legal" => {
            let st = status_of(ind, "legal");
            if st != "ok" && st != "empty" {
                return (None, "司法数据未采集（数据不足）".into());
            }
            let legal = &ind["legal"];
            let mut s = 100.0f64;
            s -= (50.0f64).min(num_of(legal, "count") * 6.0);
            s -= (25.0f64).min(num_of(legal, "penalty") * 10.0);
            s -= (20.0f64).min(num_of(legal, "criminal") * 20.0);
            s -= (15.0f64).min(num_of(legal, "trademark_admin") * 4.0);
            if num_of(legal, "amount") >= 10000.0 {
                s -= 10.0;
            }
            (
                Some(clamp_score(s)),
                format!("司法/行政记录 {} 项 · 涉案 {:.0} 万", num_of(legal, "count"), num_of(legal, "amount")),
            )
        }
        "news" => {
            let st = status_of(ind, "news");
            if st != "ok" && st != "empty" {
                return (None, "舆情数据未采集（数据不足）".into());
            }
            let n = &ind["news"];
            let mut s = 100.0f64;
            s -= (60.0f64).min(num_of(n, "negative_ratio") * 120.0);
            s -= (15.0f64).min(num_of(n, "recent_negative") * 3.0);
            (
                Some(clamp_score(s)),
                format!(
                    "新闻 {} 条 · 负面 {} 条（{:.0}%）",
                    num_of(n, "total"),
                    num_of(n, "negative"),
                    num_of(n, "negative_ratio") * 100.0
                ),
            )
        }
        "operation" => {
            let op = &ind["operation"];
            let age = op.get("age_years").and_then(|v| v.as_i64());
            let has_fin = status_of(ind, "finance") == "ok"
                && (op.get("net_margin").map(|v| !v.is_null()).unwrap_or(false)
                    || op.get("revenue_growth").map(|v| !v.is_null()).unwrap_or(false));
            if age.is_none() && !has_fin {
                return (None, "无成立年限与财务数据（数据不足）".into());
            }
            let mut s = if age.is_some() { 95.0 } else { 90.0 };
            if let Some(age) = age {
                if age < 2 {
                    s -= 10.0;
                } else if age < 5 {
                    s -= 5.0;
                } else if age >= 10 {
                    s += 5.0;
                }
            }
            if let Some(m) = op.get("net_margin").and_then(|v| v.as_f64()) {
                if m < 0.0 {
                    s -= 30.0;
                } else if m < 5.0 {
                    s -= 8.0;
                } else if m > 20.0 {
                    s += 3.0;
                }
            }
            if let Some(g) = op.get("revenue_growth").and_then(|v| v.as_f64()) {
                if g < 0.0 {
                    s -= 15.0;
                } else if g > 20.0 {
                    s += 3.0;
                }
            }
            let mut note = match age {
                Some(a) => format!("成立 {a} 年"),
                None => "成立年限未知".into(),
            };
            if let Some(m) = op.get("net_margin").and_then(|v| v.as_f64()) {
                note.push_str(&format!(" · 净利润率 {m}%"));
            }
            if let Some(g) = op.get("revenue_growth").and_then(|v| v.as_f64()) {
                note.push_str(&format!(" · 营收增速 {g}%"));
            }
            (Some(clamp_score(s)), note)
        }
        "credit" => {
            let st = status_of(ind, "legal");
            if st != "ok" && st != "empty" {
                return (None, "信用/司法数据未采集（数据不足）".into());
            }
            let c = &ind["credit"];
            let mut s = 100.0f64;
            s -= (45.0f64).min(num_of(c, "shixin") * 40.0);
            s -= (35.0f64).min(num_of(c, "zhixing") * 30.0);
            s -= (25.0f64).min(num_of(c, "penalty") * 12.0);
            (
                Some(clamp_score(s)),
                format!(
                    "失信 {} 次 · 被执行 {} 次 · 行政处罚 {} 次",
                    num_of(c, "shixin"),
                    num_of(c, "zhixing"),
                    num_of(c, "penalty")
                ),
            )
        }
        "supply" => {
            let sl = status_of(ind, "legal");
            let sn = status_of(ind, "news");
            if sl != "ok" && sl != "empty" && sn != "ok" && sn != "empty" {
                return (None, "供应链相关数据未采集（数据不足）".into());
            }
            let sp = &ind["supply"];
            let mut s = 100.0f64;
            s -= (45.0f64).min(num_of(sp, "contract_disputes") * 8.0);
            s -= (25.0f64).min(num_of(sp, "supply_news_negative") * 8.0);
            (
                Some(clamp_score(s)),
                format!(
                    "合同类纠纷 {} 项 · 供应链负面舆情 {} 条",
                    num_of(sp, "contract_disputes"),
                    num_of(sp, "supply_news_negative")
                ),
            )
        }
        _ => (None, "未知维度".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DimensionView {
    pub score: Option<i64>,
    pub level: String,
    pub label: String,
    pub indicators: Value,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Verdict {
    pub score: Option<f64>,
    pub grade: String,
    pub grade_label: String,
    pub level: String,
    pub dimensions: BTreeMap<String, DimensionView>,
    pub indicators: Value,
    pub data_status: BTreeMap<String, String>,
}

/// 六维评分 + 综合评分 + 等级
pub fn rules_verdict(db: &Db, enterprise_id: i64) -> Result<Verdict> {
    let ind = compute_indicators(db, enterprise_id)?;
    let mut dims = BTreeMap::new();
    let mut scores: Vec<i64> = Vec::new();
    for dim in DIMS {
        let (score, note) = dim_score(dim, &ind);
        if let Some(v) = score {
            scores.push(v);
        }
        dims.insert(
            dim.to_string(),
            DimensionView {
                score,
                level: score_to_level(score).to_string(),
                label: dim_label(dim).to_string(),
                indicators: ind.get(dim).cloned().unwrap_or(json!({})),
                note,
            },
        );
    }

    let overall = if scores.is_empty() {
        None
    } else {
        let avg = scores.iter().sum::<i64>() as f64 / scores.len() as f64;
        Some((avg * 10.0).round() / 10.0)
    };
    let (mut grade, mut grade_label) = grade_of(overall);
    let mut level = score_to_level(overall.map(|v| v.round() as i64)).to_string();
    if scores.is_empty() {
        grade = "—".into();
        grade_label = "无数据，无法评估".into();
        level = "gray".into();
    }

    let mut data_status = BTreeMap::new();
    if let Some(obj) = ind.get("data_status").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            data_status.insert(k.clone(), v.as_str().unwrap_or("never").to_string());
        }
    }

    Ok(Verdict { score: overall, grade, grade_label, level, dimensions: dims, indicators: ind, data_status })
}

/// 供工具使用的精简画像
pub fn brief(_db: &Db, id: i64, name: &str, industry: &str, verdict: &Verdict) -> Value {
    json!({
        "id": id,
        "name": name,
        "industry": industry,
        "score": verdict.score,
        "grade": verdict.grade,
        "level": verdict.level,
    })
}

#[allow(dead_code)]
fn _unused(_conn: &Connection) {}

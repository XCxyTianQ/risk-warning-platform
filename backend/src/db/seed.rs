//! 样例数据灌入：读取 `data/samples/dataset.json`（与 Python 版同一份公开信源演示数据）。
//!
//! 数据状态口径与原实现一致：
//!   finance: 有财报=ok / 无=never
//!   legal:   有记录=ok / 确实没有=empty
//!   news:    有新闻=ok / 确实没有=empty

use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;

use super::Db;

#[derive(Deserialize)]
struct Dataset {
    enterprises: Vec<SampleEnterprise>,
}

#[derive(Deserialize)]
struct SampleEnterprise {
    name: String,
    #[serde(default)]
    unified_code: String,
    #[serde(default)]
    stock_code: String,
    #[serde(default)]
    legal_rep: String,
    #[serde(default)]
    reg_capital_wan: f64,
    #[serde(default)]
    reg_date: String,
    #[serde(default)]
    industry: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    data_note: String,
    #[serde(default)]
    legal_records: Vec<serde_json::Value>,
    #[serde(default)]
    news: Vec<serde_json::Value>,
    #[serde(default)]
    finance: Vec<serde_json::Value>,
}

fn text(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn num(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// 灌入样例数据，返回企业数量
pub fn seed_from_samples(db: &Db, samples_dir: &Path) -> Result<usize> {
    let path = samples_dir.join("dataset.json");
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("读取样例数据失败：{}", path.display()))?;
    let dataset: Dataset = serde_json::from_str(&raw).context("解析 dataset.json 失败")?;

    let now = crate::util::now_db();
    let mut count = 0usize;

    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        for ent in &dataset.enterprises {
            let status = json!({
                "finance": if ent.finance.is_empty() { "never" } else { "ok" },
                "legal": if ent.legal_records.is_empty() { "empty" } else { "ok" },
                "news": if ent.news.is_empty() { "empty" } else { "ok" },
            });
            tx.execute(
                "INSERT OR IGNORE INTO enterprise
                 (name, unified_code, stock_code, legal_rep, reg_capital_wan, reg_date,
                  industry, address, data_note, data_status_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                rusqlite::params![
                    ent.name,
                    ent.unified_code,
                    ent.stock_code,
                    ent.legal_rep,
                    ent.reg_capital_wan,
                    ent.reg_date,
                    ent.industry,
                    ent.address,
                    ent.data_note,
                    status.to_string(),
                ],
            )?;
            let eid: i64 = tx.query_row(
                "SELECT id FROM enterprise WHERE name = ?1",
                [&ent.name],
                |r| r.get(0),
            )?;

            for r in &ent.legal_records {
                tx.execute(
                    "INSERT INTO legal_record
                     (enterprise_id, case_no, doc_type, title, court, cause, amount, status, judgment_date, source)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![
                        eid,
                        text(r, "case_no"),
                        text(r, "doc_type"),
                        text(r, "title"),
                        text(r, "court"),
                        text(r, "cause"),
                        num(r, "amount"),
                        text(r, "status"),
                        text(r, "judgment_date"),
                        text(r, "source"),
                    ],
                )?;
            }
            for n in &ent.news {
                tx.execute(
                    "INSERT INTO news (enterprise_id, title, content, source, url, published_at, sentiment)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![
                        eid,
                        text(n, "title"),
                        text(n, "content"),
                        text(n, "source"),
                        text(n, "url"),
                        text(n, "published_at"),
                        if text(n, "sentiment").is_empty() { "neutral".into() } else { text(n, "sentiment") },
                    ],
                )?;
            }
            for f in &ent.finance {
                tx.execute(
                    "INSERT OR REPLACE INTO finance
                     (enterprise_id, year, report_type, total_assets, total_liabilities,
                      revenue, net_profit, debt_ratio, source, metrics_json)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![
                        eid,
                        text(f, "year"),
                        if text(f, "report_type").is_empty() { "年报".into() } else { text(f, "report_type") },
                        num(f, "total_assets"),
                        num(f, "total_liabilities"),
                        num(f, "revenue"),
                        num(f, "net_profit"),
                        num(f, "debt_ratio"),
                        text(f, "source"),
                        f.get("metrics_json").and_then(|x| x.as_str()).unwrap_or("{}"),
                    ],
                )?;
            }
            count += 1;
        }
        tx.commit()?;
        Ok(())
    })?;

    let _ = now;
    Ok(count)
}

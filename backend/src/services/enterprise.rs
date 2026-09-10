//! 企业创建 / 删除 / 标的解析（自由添加企业）。
//!
//! 关键校验（与 Python 版一致）：**三源都查不到的企业不建档**，
//! 避免出现"无数据却 100 分"的假画像。

use anyhow::Result;
use serde_json::{json, Value};

use crate::datasources::{self, refresh_enterprise};
use crate::db::Db;
use crate::util::normalize_code;

/// 异步版标的解析（代码 → 名称按需查询，名称 → 代码走搜索建议）
pub async fn lookup_stock_async(query: &str) -> Value {
    let q = query.trim();
    let code = normalize_code(q);
    let candidates: Vec<Value> = if let Some(code) = &code {
        let name = datasources::name_of_async(code).await;
        if name.is_empty() {
            vec![]
        } else {
            vec![json!({ "code": code, "name": name })]
        }
    } else {
        datasources::resolve_code_async(q, 8)
            .await
            .into_iter()
            .map(|(code, name)| json!({ "code": code, "name": name }))
            .collect()
    };
    let mut out = json!({ "query": q, "candidates": candidates });
    if let Some(code) = code {
        out["stock_code"] = json!(code);
        out["resolved_name"] = json!(datasources::name_of(&code));
    }
    out
}

/// 新建企业（auto_fetch=true 时拉取公开数据，三源皆空则回滚建档）
pub async fn create_enterprise(
    db: &Db,
    name: &str,
    stock_code: Option<&str>,
    auto_fetch: bool,
    industry: &str,
) -> Result<Value> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(json!({ "error": "企业名称不能为空" }));
    }

    // 名称已存在
    let existing: Option<(i64, String)> = db.with(|conn| {
        let r = conn.query_row("SELECT id, name FROM enterprise WHERE name = ?1", [name], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        });
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    if let Some((id, existing_name)) = existing {
        return Ok(json!({ "error": format!("企业已存在：{existing_name}（id={id}）"), "enterprise_id": id }));
    }

    // 输入即代码时先查重（避免与已建档企业重复）
    let input_code = normalize_code(name);
    if let Some(code) = &input_code {
        let dup: Option<(i64, String)> = db.with(|conn| {
            let r = conn.query_row(
                "SELECT id, name FROM enterprise WHERE stock_code = ?1",
                [code],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            );
            match r {
                Ok(v) => Ok(Some(v)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })?;
        if let Some((id, dup_name)) = dup {
            return Ok(json!({
                "error": format!("企业已存在：{dup_name}（{code}，id={id}）"),
                "enterprise_id": id,
            }));
        }
    }

    // 解析代码：用户指定 → 代码输入 → 名称严格匹配
    let mut resolved_from = String::new();
    let mut matched_name = String::new();
    let mut code = stock_code.map(|c| normalize_code(c).unwrap_or_else(|| c.trim().to_string())).unwrap_or_default();
    if !code.is_empty() {
        resolved_from = "用户指定".into();
        matched_name = datasources::name_of_async(&code).await;
    } else {
        if let Some(hit) = datasources::resolve_code_strict_async(name).await {
            code = hit.0;
            matched_name = hit.1;
            resolved_from = if input_code.is_some() { "代码解析".into() } else { "名称解析".into() };
        }
    }

    if code.is_empty() {
        let candidates = datasources::resolve_code_async(name, 5).await;
        let hint = if candidates.is_empty() {
            "未匹配到任何 A 股证券简称".to_string()
        } else {
            format!(
                "候选：{}",
                candidates
                    .iter()
                    .map(|(c, n)| format!("{n}({c})"))
                    .collect::<Vec<_>>()
                    .join("、")
            )
        };
        return Ok(json!({
            "error": format!("未找到企业「{name}」的公开数据源：A股代码解析失败（{hint}）。请检查名称，或直接提供股票代码；非上市企业请使用人工数据导入。"),
            "candidates": candidates.into_iter().map(|(c, n)| json!({ "code": c, "name": n })).collect::<Vec<_>>(),
        }));
    }

    let final_name = if matched_name.is_empty() { name.to_string() } else { matched_name };
    let industry_value = if industry.trim().is_empty() { "上市公司".to_string() } else { industry.trim().to_string() };
    let note = format!("用户添加：股票代码 {code}（{resolved_from}）");

    let enterprise_id = db.with(|conn| {
        conn.execute(
            "INSERT INTO enterprise (name, stock_code, industry, data_note, data_status_json)
             VALUES (?1, ?2, ?3, ?4, '{}')",
            rusqlite::params![final_name, code, industry_value, note],
        )?;
        Ok(conn.last_insert_rowid())
    })?;

    let mut out = json!({
        "enterprise_id": enterprise_id,
        "name": final_name,
        "stock_code": code,
        "resolved_from": resolved_from,
        "auto_fetch": auto_fetch,
    });
    if !auto_fetch {
        out["warning"] = json!("未自动拉取数据；该企业暂无数据，评分将显示为「无数据，无法评估」");
        return Ok(out);
    }

    let refresh = refresh_enterprise(db, enterprise_id, None).await?;
    let got_data = refresh
        .get("data_status")
        .and_then(|v| v.as_object())
        .map(|m| m.values().any(|v| v.as_str() == Some("ok")))
        .unwrap_or(false);
    if !got_data {
        hard_delete(db, enterprise_id)?;
        return Ok(json!({
            "error": format!("未找到企业「{final_name}」（{code}）的公开数据：新浪财经 / 东方财富 / 巨潮资讯 均无对应记录，已撤销建档。请确认名称或代码是否正确。"),
            "stock_code": code,
            "data_status": refresh.get("data_status").cloned().unwrap_or(json!({})),
        }));
    }
    out["refresh"] = refresh;
    Ok(out)
}

/// 彻底删除（含关联数据）
pub fn hard_delete(db: &Db, enterprise_id: i64) -> Result<()> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        for table in ["risk_fact", "finance", "news", "legal_record", "alert"] {
            tx.execute(&format!("DELETE FROM {table} WHERE enterprise_id = ?1"), [enterprise_id])?;
        }
        tx.execute("DELETE FROM enterprise WHERE id = ?1", [enterprise_id])?;
        tx.commit()?;
        Ok(())
    })
}

pub fn delete_enterprise(db: &Db, enterprise_id: i64) -> Result<Value> {
    let name: Option<String> = db.with(|conn| {
        let r = conn.query_row("SELECT name FROM enterprise WHERE id = ?1", [enterprise_id], |r| r.get(0));
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    match name {
        Some(name) => {
            hard_delete(db, enterprise_id)?;
            Ok(json!({ "deleted": enterprise_id, "name": name }))
        }
        None => Ok(json!({ "error": format!("企业不存在: {enterprise_id}") })),
    }
}

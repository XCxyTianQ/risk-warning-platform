//! 企业档案接口（P0 先提供列表与详情；评分/研判在后续阶段接入）。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppResult;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub q: String,
}

/// GET /api/enterprises?q=名称/代码/行业
pub async fn list(
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let kw = q.q.trim().to_string();
    let items = st.db.with(|conn| {
        let mut stmt = if kw.is_empty() {
            conn.prepare(
                "SELECT id, name, industry, reg_date, stock_code FROM enterprise ORDER BY id",
            )?
        } else {
            conn.prepare(
                "SELECT id, name, industry, reg_date, stock_code FROM enterprise
                 WHERE name LIKE ?1 OR industry LIKE ?1 OR stock_code LIKE ?1 OR unified_code LIKE ?1
                 ORDER BY id",
            )?
        };
        let like = format!("%{kw}%");
        let rows = if kw.is_empty() {
            stmt.query_map([], row_to_json)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([&like], row_to_json)?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    })?;
    Ok(Json(json!({ "total": items.len(), "items": items })))
}

fn row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "name": row.get::<_, String>(1)?,
        "industry": row.get::<_, String>(2)?,
        "reg_date": row.get::<_, String>(3)?,
        "stock_code": row.get::<_, String>(4)?,
    }))
}

/// GET /api/enterprise/{id}
pub async fn get_one(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let item = st.db.with(|conn| {
        let row = conn.query_row(
            "SELECT id, name, unified_code, stock_code, legal_rep, reg_capital_wan,
                    reg_date, industry, address, data_note
             FROM enterprise WHERE id = ?1",
            [id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "unified_code": r.get::<_, String>(2)?,
                    "stock_code": r.get::<_, String>(3)?,
                    "legal_rep": r.get::<_, String>(4)?,
                    "reg_capital_wan": r.get::<_, f64>(5)?,
                    "reg_date": r.get::<_, String>(6)?,
                    "industry": r.get::<_, String>(7)?,
                    "address": r.get::<_, String>(8)?,
                    "data_note": r.get::<_, String>(9)?,
                }))
            },
        );
        match row {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    match item {
        Some(v) => Ok(Json(v)),
        None => Err(crate::error::AppError(anyhow::anyhow!("企业不存在: {id}"))),
    }
}

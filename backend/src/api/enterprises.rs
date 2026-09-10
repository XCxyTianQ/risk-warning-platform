//! 企业档案接口：列表 / 详情 / 添加 / 刷新 / 标的解析 / 数据源状态。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::datasources;
use crate::error::{AppError, AppResult};
use crate::services::enterprise as ent_service;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub q: String,
}

/// GET /api/enterprises?q=名称/代码/行业
pub async fn list(State(st): State<AppState>, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let kw = q.q.trim().to_string();
    let items = st.db.with(|conn| {
        let sql = if kw.is_empty() {
            "SELECT id, name, industry, reg_date, stock_code FROM enterprise ORDER BY id".to_string()
        } else {
            "SELECT id, name, industry, reg_date, stock_code FROM enterprise
             WHERE name LIKE ?1 OR industry LIKE ?1 OR stock_code LIKE ?1 OR unified_code LIKE ?1
             ORDER BY id"
                .to_string()
        };
        let mut stmt = conn.prepare(&sql)?;
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "industry": row.get::<_, String>(2)?,
                "reg_date": row.get::<_, String>(3)?,
                "stock_code": row.get::<_, String>(4)?,
            }))
        };
        let rows = if kw.is_empty() {
            stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?
        } else {
            let like = format!("%{kw}%");
            stmt.query_map([&like], map_row)?.collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    })?;
    Ok(Json(json!({ "total": items.len(), "items": items })))
}

/// GET /api/enterprise/{id}
pub async fn get_one(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let item = st.db.with(|conn| {
        let row = conn.query_row(
            "SELECT id, name, unified_code, stock_code, legal_rep, reg_capital_wan,
                    reg_date, industry, address, data_note, data_status_json
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
                    "data_status": serde_json::from_str::<Value>(&r.get::<_, String>(10)?).unwrap_or(json!({})),
                }))
            },
        );
        match row {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    item.map(Json).ok_or_else(|| AppError::not_found(format!("enterprise {id} not found")))
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub name: String,
    #[serde(default)]
    pub stock_code: Option<String>,
    #[serde(default = "default_true")]
    pub auto_fetch: bool,
    #[serde(default)]
    pub industry: String,
}

fn default_true() -> bool {
    true
}

/// POST /api/enterprises —— 自由添加企业（自动解析代码并拉取公开数据）
pub async fn create(
    State(st): State<AppState>,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<Value>> {
    let result = ent_service::create_enterprise(
        &st.db,
        &req.name,
        req.stock_code.as_deref(),
        req.auto_fetch,
        &req.industry,
    )
    .await?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        let status = if err.contains("已存在") {
            axum::http::StatusCode::CONFLICT
        } else {
            axum::http::StatusCode::BAD_REQUEST
        };
        return Err(AppError::new(status, err));
    }
    Ok(Json(result))
}

/// DELETE /api/enterprise/{id}
pub async fn delete(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = ent_service::delete_enterprise(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct RefreshQuery {
    #[serde(default)]
    pub dimensions: Option<String>,
}

/// POST /api/enterprise/{id}/refresh?dimensions=finance,news,legal
pub async fn refresh(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<RefreshQuery>,
) -> AppResult<Json<Value>> {
    let dims = q.dimensions.map(|d| {
        d.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    });
    let result = datasources::refresh_enterprise(&st.db, id, dims).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct ResolveQuery {
    #[serde(default)]
    pub name: String,
}

/// GET /api/resolve_stock?name=康美药业 或 600518
pub async fn resolve_stock(
    State(_st): State<AppState>,
    Query(q): Query<ResolveQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(ent_service::lookup_stock_async(&q.name).await))
}

/// GET /api/datasources —— 数据源与维度覆盖
pub async fn datasources_status() -> Json<Value> {
    Json(json!({
        "sources": [
            { "dimension": "finance", "mode": "merge",
              "sources": [
                  { "name": "新浪财经/关键指标", "dimensions": ["finance"] },
                  { "name": "新浪财经/三表", "dimensions": ["finance"] }
              ] },
            { "dimension": "news", "mode": "merge",
              "sources": [{ "name": "东方财富/公告", "dimensions": ["news"] }] },
            { "dimension": "legal", "mode": "fallback",
              "sources": [{ "name": "巨潮资讯/公司诉讼统计", "dimensions": ["legal"] }] }
        ]
    }))
}

//! 表格对象 API：`/api/tables/*`（在线创建 / 在线编辑 / 读取结果入库）。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::services::tables;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub enterprise_id: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
}

/// GET /api/tables —— 表格列表（可按企业/状态筛选）
pub async fn list(State(st): State<AppState>, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    Ok(Json(tables::list(&st.db, q.enterprise_id, q.status.as_deref())?))
}

/// GET /api/tables/templates —— 模板与字段字典（前端"新建表格"与映射下拉用）
pub async fn templates() -> Json<Value> {
    Json(tables::templates())
}

#[derive(Deserialize)]
pub struct CreateReq {
    #[serde(default)]
    pub enterprise_id: Option<i64>,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 期间列：[["2025","年报"],["2024","年报"]] 或 ["2025","2024"]
    #[serde(default)]
    pub periods: Value,
    #[serde(default = "default_unit")]
    pub unit: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default = "default_period_type")]
    pub period_type: String,
    #[serde(default = "default_origin")]
    pub origin: String,
}

fn default_kind() -> String {
    "kpi".into()
}
fn default_unit() -> String {
    "万元".into()
}
fn default_scope() -> String {
    "合并报表".into()
}
fn default_period_type() -> String {
    "年报".into()
}
fn default_origin() -> String {
    "manual".into()
}

fn parse_periods(raw: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for p in raw.as_array().cloned().unwrap_or_default() {
        match p {
            Value::String(s) => out.push((s, "年报".to_string())),
            Value::Array(a) => {
                let period = a.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
                let rt = a.get(1).and_then(|v| v.as_str()).unwrap_or("年报").to_string();
                if !period.is_empty() {
                    out.push((period, rt));
                }
            }
            _ => {}
        }
    }
    if out.is_empty() {
        out.push(("2025".into(), "年报".into()));
    }
    out
}

/// POST /api/tables —— 在线创建（模板或空白）
pub async fn create(State(st): State<AppState>, Json(req): Json<CreateReq>) -> AppResult<Json<Value>> {
    let periods = parse_periods(&req.periods);
    let result = tables::create(
        &st.db,
        req.enterprise_id,
        &req.title,
        &req.kind,
        &periods,
        &req.unit,
        &req.scope,
        &req.period_type,
        &req.origin,
    )?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    // 返回完整对象，前端可直接打开编辑器
    let id = result.get("table_id").and_then(|v| v.as_i64()).unwrap_or(0);
    let doc = tables::get(&st.db, id)?.ok_or_else(|| AppError::internal("表格创建后读取失败"))?;
    let mut out = result.as_object().cloned().unwrap_or_default();
    out.insert("table".into(), doc.to_json());
    Ok(Json(Value::Object(out)))
}

/// GET /api/tables/{id}
pub async fn get_one(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let doc = tables::get(&st.db, id)?.ok_or_else(|| AppError::not_found(format!("表格不存在: {id}")))?;
    Ok(Json(doc.to_json()))
}

/// PATCH /api/tables/{id} —— 更新元数据 / 整表结构
pub async fn update(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = tables::update(&st.db, id, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

/// POST /api/tables/{id}/cells —— 写入单元格（单点 / 区域 / 单行）
pub async fn write_cells(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let result = tables::write_cells(&st.db, id, &body)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/tables/{id}/validate —— 勾稽校验（不写库）
pub async fn validate(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let doc = tables::get(&st.db, id)?.ok_or_else(|| AppError::not_found(format!("表格不存在: {id}")))?;
    Ok(Json(tables::validate(&doc)))
}

/// GET /api/tables/{id}/preview —— 入库差异预览（不写库）
pub async fn preview(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = tables::preview_ingest(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct IngestReq {
    #[serde(default)]
    pub overwrite: bool,
}

/// POST /api/tables/{id}/ingest —— 入库（写操作；默认不覆盖公开信源数据）
pub async fn ingest(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    body: Option<Json<IngestReq>>,
) -> AppResult<Json<Value>> {
    let overwrite = body.map(|Json(b)| b.overwrite).unwrap_or(false);
    let result = tables::ingest(&st.db, id, overwrite)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// DELETE /api/tables/{id}
pub async fn delete(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let result = tables::delete(&st.db, id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct ConfirmReq {
    /// 要确认的单元格；留空 = 确认全部待确认（视觉识别）单元格
    #[serde(default)]
    pub cells: Vec<Value>,
}

/// POST /api/tables/{id}/confirm —— 确认视觉识别结果（source: vision → user）
pub async fn confirm(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    body: Option<Json<ConfirmReq>>,
) -> AppResult<Json<Value>> {
    let cells = body.map(|Json(b)| b.cells).unwrap_or_default();
    let result = tables::confirm_cells(&st.db, id, &cells)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

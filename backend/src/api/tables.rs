//! 表格对象 API：`/api/tables/*`（在线创建 / 在线编辑 / 读取结果入库）。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

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

#[derive(Deserialize)]
pub struct ImportReq {
    /// 已上传的表格文件（csv/xlsx/xls）附件 id
    #[serde(default)]
    pub attachment_id: Option<String>,
    /// 或直接给文本（从 Excel 复制粘贴的 TSV/CSV）
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub enterprise_id: Option<i64>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    /// true = 保持长表原样导入（不自动透视），便于后续用数据透视表处理
    #[serde(default)]
    pub keep_long: bool,
}

/// POST /api/tables/import —— 确定性解析（csv/xlsx/粘贴文本）→ 新建表格
pub async fn import(
    State(st): State<AppState>,
    Json(req): Json<ImportReq>,
) -> AppResult<Json<Value>> {
    use crate::services::sheet_import;

    let (grid, default_title) = if let Some(text) = req.text.as_deref().filter(|t| !t.trim().is_empty()) {
        (sheet_import::parse_delimited(text), "粘贴导入的表格".to_string())
    } else if let Some(aid) = req.attachment_id.as_deref() {
        let att = crate::services::attachments::get(&st.db, aid)?
            .ok_or_else(|| AppError::not_found(format!("附件不存在: {aid}")))?;
        let bytes = crate::services::attachments::read_bytes(&st.cfg.data_dir, &att)?;
        let lower = att.filename.to_lowercase();
        let grid = if lower.ends_with(".csv") || att.mime.contains("csv") {
            sheet_import::parse_delimited(&String::from_utf8_lossy(&bytes))
        } else {
            sheet_import::parse_workbook(&bytes).map_err(|e| AppError::bad_request(e.to_string()))?
        };
        let title = att.filename.clone();
        (grid, title)
    } else {
        return Err(AppError::bad_request("需要 attachment_id 或 text"));
    };

    let meta = sheet_import::detect_meta(&grid);
    let unit = req
        .unit
        .filter(|u| !u.is_empty())
        .or_else(|| meta.get("unit").and_then(|v| v.as_str()).filter(|u| !u.is_empty()).map(|s| s.to_string()))
        .unwrap_or_else(|| "万元".into());
    let scope = req
        .scope
        .filter(|s| !s.is_empty())
        .or_else(|| meta.get("scope").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()))
        .unwrap_or_else(|| "合并报表".into());
    let title = if req.title.trim().is_empty() { default_title } else { req.title.clone() };

    let result = if req.keep_long {
        sheet_import::build_flat(&st.db, &grid, req.enterprise_id, &title, &unit, &scope)
            .map_err(|e| AppError::bad_request(e.to_string()))?
    } else {
        let ext = sheet_import::extract(&grid).map_err(|e| AppError::bad_request(e.to_string()))?;
        sheet_import::build_table(&st.db, &ext, req.enterprise_id, &title, &unit, &scope)
            .map_err(|e| AppError::bad_request(e.to_string()))?
    };
    let id = result.get("table_id").and_then(|v| v.as_i64()).unwrap_or(0);
    let doc = tables::get(&st.db, id)?.ok_or_else(|| AppError::internal("导入后读取失败"))?;
    let mut out = result.as_object().cloned().unwrap_or_default();
    out.insert("table".into(), doc.to_json());
    out.insert("detected".into(), json!({ "unit": unit, "scope": scope, "meta": meta }));
    Ok(Json(Value::Object(out)))
}

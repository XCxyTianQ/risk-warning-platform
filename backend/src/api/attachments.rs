//! 多模态附件 API：上传 / 预览 / 读取（视觉识别）/ 删除。

use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::services::attachments;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    50
}

/// GET /api/attachments —— 附件列表
pub async fn list(State(st): State<AppState>, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    Ok(Json(attachments::list(&st.db, q.session_id.as_deref(), q.limit.clamp(1, 200))?))
}

#[derive(Deserialize)]
pub struct UploadJson {
    pub filename: String,
    #[serde(default)]
    pub mime: String,
    /// base64（可带 data URL 前缀）
    pub data_base64: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default = "default_origin")]
    pub origin: String,
}

fn default_origin() -> String {
    "upload".into()
}

fn decode_base64(raw: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let body = raw.split_once("base64,").map(|(_, b)| b).unwrap_or(raw);
    base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|e| format!("base64 解码失败：{e}"))
}

/// POST /api/attachments —— JSON 上传（前端粘贴/拖拽小图走这条，简单且无需 multipart）
pub async fn upload_json(
    State(st): State<AppState>,
    Json(body): Json<UploadJson>,
) -> AppResult<Json<Value>> {
    let bytes = decode_base64(&body.data_base64).map_err(AppError::bad_request)?;
    let mime = if body.mime.is_empty() {
        guess_mime(&body.filename)
    } else {
        body.mime.clone()
    };
    let result = attachments::save(
        &st.db,
        &st.cfg.data_dir,
        &bytes,
        &body.filename,
        &mime,
        &body.session_id,
        &body.origin,
    )?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/attachments/raw —— 原始字节上传（大文件：xlsx/csv）
/// 文件名走 `X-Filename` 头，类型走 `Content-Type`
pub async fn upload_raw(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let filename = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(|s| percent_decode(s))
        .unwrap_or_else(|| "upload.bin".to_string());
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let session_id = headers
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let result = attachments::save(
        &st.db,
        &st.cfg.data_dir,
        &body,
        &filename,
        &mime,
        &session_id,
        "upload",
    )?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::bad_request(err));
    }
    Ok(Json(result))
}

/// POST /api/attachments/multipart —— 标准 multipart 上传（表单字段名 `file`）
pub async fn upload_multipart(
    State(st): State<AppState>,
    mut form: Multipart,
) -> AppResult<Json<Value>> {
    let mut saved: Option<Value> = None;
    let mut session_id = String::new();
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(format!("表单解析失败：{e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "session_id" {
            session_id = field.text().await.unwrap_or_default();
            continue;
        }
        if name != "file" && name != "files" {
            continue;
        }
        let filename = field.file_name().unwrap_or("upload.bin").to_string();
        let mime = field.content_type().map(|m| m.to_string()).unwrap_or_default();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::bad_request(format!("读取上传内容失败：{e}")))?;
        let mime = if mime.is_empty() { guess_mime(&filename) } else { mime };
        let result = attachments::save(
            &st.db,
            &st.cfg.data_dir,
            &bytes,
            &filename,
            &mime,
            &session_id,
            "upload",
        )?;
        if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
            return Err(AppError::bad_request(err));
        }
        saved = Some(result);
        break;
    }
    saved.ok_or_else(|| AppError::bad_request("未收到文件（字段名应为 file）"))
        .map(Json)
}

/// GET /api/attachments/{id} —— 取原始字节（前端缩略图/查看原图）
pub async fn get_raw(State(st): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let att = attachments::get(&st.db, &id)?
        .ok_or_else(|| AppError::not_found(format!("附件不存在: {id}")))?;
    let bytes = attachments::read_bytes(&st.cfg.data_dir, &att)?;
    let mime = if att.mime.is_empty() { "application/octet-stream" } else { &att.mime };
    Ok(([(header::CONTENT_TYPE, mime.to_string())], bytes).into_response())
}

/// GET /api/attachments/{id}/meta
pub async fn get_meta(State(st): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let att = attachments::get(&st.db, &id)?
        .ok_or_else(|| AppError::not_found(format!("附件不存在: {id}")))?;
    Ok(Json(att.to_json()))
}

/// DELETE /api/attachments/{id}
pub async fn delete(State(st): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let result = attachments::delete(&st.db, &st.cfg.data_dir, &id)?;
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(AppError::not_found(err));
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct ReadReq {
    /// finance（财报表格抽取）/ announcement（公告事实抽取）/ auto
    #[serde(default = "default_target")]
    pub target: String,
    /// 指定表格：识别结果直接填入该表格（待确认状态）
    #[serde(default)]
    pub table_id: Option<i64>,
    /// 只返回读取结果，不落库
    #[serde(default)]
    pub dry_run: bool,
}

fn default_target() -> String {
    "auto".into()
}

/// POST /api/attachments/{id}/read —— 视觉读取，产出结构化 Reading
pub async fn read_one(
    State(st): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<ReadReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or(ReadReq {
        target: default_target(),
        table_id: None,
        dry_run: false,
    });
    match crate::services::reading::read_attachment(&st, &id, &req.target, req.table_id, req.dry_run).await {
        Ok(v) => {
            if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
                return Err(AppError::bad_request(err));
            }
            Ok(Json(v))
        }
        Err(err) => Err(AppError::internal(format!("读取失败：{err}"))),
    }
}

fn guess_mime(filename: &str) -> String {
    let lower = filename.to_lowercase();
    if lower.ends_with(".png") {
        "image/png".into()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".into()
    } else if lower.ends_with(".webp") {
        "image/webp".into()
    } else if lower.ends_with(".gif") {
        "image/gif".into()
    } else if lower.ends_with(".bmp") {
        "image/bmp".into()
    } else if lower.ends_with(".csv") {
        "text/csv".into()
    } else if lower.ends_with(".xlsx") {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()
    } else if lower.ends_with(".xls") {
        "application/vnd.ms-excel".into()
    } else {
        "application/octet-stream".into()
    }
}

fn percent_decode(raw: &str) -> String {
    // 前端把中文文件名做了 encodeURIComponent；这里做最小可用解码
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

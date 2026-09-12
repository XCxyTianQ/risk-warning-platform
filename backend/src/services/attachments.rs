//! 多模态附件与「读取（Reading）」。
//!
//! 三层职责分得很清：
//!  1. **输入**：字节怎么进来（粘贴 / 拖拽 / 选择文件 / 拍照）—— 统一落盘、按 sha256 去重；
//!  2. **读取**：字节怎么变成意思 —— 视觉模型 / 确定性解析 / 人工修正，产出统一的 **Reading**；
//!  3. **消费**：对话（当期多模态 + 历史文本化）与表格（识别结果填入 TableDoc 再入库）。
//!
//! Reading 的形态（与表格/证据链共用）：
//! ```json
//! {
//!   "kind": "table|text|keyvalue|image",
//!   "method": "vision|deterministic|manual",
//!   "confidence": 0.0~1.0,
//!   "title": "2025 年报主要财务数据",
//!   "fields": [{"label":"营业总收入","field":"revenue_wan","value":128600,"unit":"万元","confidence":0.8}],
//!   "table": {"columns":[...], "rows":[[...]]},      // 可选：二维表
//!   "meta": {"unit":"万元","scope":"合并报表","period":"2025"},
//!   "notes": ["单位按表头推断", "…"],
//!   "raw_text": "模型原始输出（截断保存，便于复核）"
//! }
//! ```

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use base64::Engine as _;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::db::Db;
use crate::util::now_db;

/// 允许的图片类型（前端压缩后上传；不做 OCR 之外的转码）
pub const ALLOWED_MIME: [&str; 5] = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
/// 单文件上限：6 MB（超大图应先在前端压缩）
pub const MAX_BYTES: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Attachment {
    pub id: String,
    pub session_id: String,
    pub message_id: Option<i64>,
    pub kind: String,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub sha256: String,
    pub width: i64,
    pub height: i64,
    pub file_path: String,
    pub origin: String,
    pub reading: Option<Value>,
    pub reading_method: String,
    pub reading_status: String,
    pub created_at: String,
}

impl Attachment {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "session_id": self.session_id,
            "message_id": self.message_id,
            "kind": self.kind,
            "filename": self.filename,
            "mime": self.mime,
            "size": self.size,
            "sha256": self.sha256,
            "width": self.width,
            "height": self.height,
            "origin": self.origin,
            "reading": self.reading,
            "reading_method": self.reading_method,
            "reading_status": self.reading_status,
            "preview_url": format!("/api/attachments/{}", self.id),
            "created_at": crate::util::db_to_iso(&self.created_at),
        })
    }

    /// 供上下文使用的文本投影（历史轮次用，避免重复发送图片）
    pub fn text_projection(&self) -> String {
        let mut parts = vec![format!(
            "（附图：{}，{} KB）",
            if self.filename.is_empty() { "未命名" } else { &self.filename },
            (self.size as f64 / 1024.0).round() as i64
        )];
        if let Some(reading) = &self.reading {
            if let Some(fields) = reading.get("fields").and_then(|v| v.as_array()) {
                let brief: Vec<String> = fields
                    .iter()
                    .filter_map(|f| {
                        let label = f.get("label").and_then(|v| v.as_str())?;
                        let value = f.get("value")?;
                        let unit = f.get("unit").and_then(|v| v.as_str()).unwrap_or("");
                        Some(format!("{label} {value}{unit}"))
                    })
                    .take(12)
                    .collect();
                if !brief.is_empty() {
                    parts.push(format!("已识别：{}", brief.join("；")));
                }
            }
        } else if self.reading_status == "none" {
            parts.push("尚未读取".into());
        }
        parts.join("｜")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    // 自实现 SHA-256（避免为一个哈希再引入依赖；实现见下）
    sha256(bytes)
}

// ---------------------------------------------------------------------------
// SHA-256（FIPS 180-4 精简实现：只用于内容去重与文件命名）
// ---------------------------------------------------------------------------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

fn ext_of(filename: &str, mime: &str) -> String {
    if let Some(ext) = Path::new(filename).extension().and_then(|e| e.to_str()) {
        let e = ext.to_lowercase();
        if !e.is_empty() && e.len() <= 5 {
            return e;
        }
    }
    match mime {
        "image/png" => "png".into(),
        "image/jpeg" => "jpg".into(),
        "image/webp" => "webp".into(),
        "image/gif" => "gif".into(),
        "image/bmp" => "bmp".into(),
        _ => "bin".into(),
    }
}

/// 保存上传字节：内容寻址落盘（去重）+ 元数据入库
#[allow(clippy::too_many_arguments)]
pub fn save(
    db: &Db,
    data_dir: &Path,
    bytes: &[u8],
    filename: &str,
    mime: &str,
    session_id: &str,
    origin: &str,
) -> Result<Value> {
    if bytes.is_empty() {
        return Ok(json!({ "error": "文件内容为空" }));
    }
    if bytes.len() > MAX_BYTES {
        return Ok(json!({
            "error": format!("文件过大（{:.1} MB），上限 {} MB；图片请先压缩长边至 1600px 以内",
                bytes.len() as f64 / 1048576.0, MAX_BYTES / 1048576),
        }));
    }
    let is_image = ALLOWED_MIME.contains(&mime) || mime.starts_with("image/");
    let is_table = mime.contains("sheet")
        || mime.contains("csv")
        || filename.ends_with(".xlsx")
        || filename.ends_with(".xls")
        || filename.ends_with(".csv");
    if !is_image && !is_table {
        return Ok(json!({
            "error": format!("暂不支持的类型：{mime}（支持图片与 csv/xlsx/xls）"),
        }));
    }

    let sha = sha256_hex(bytes);
    // 去重：同一内容已存在则复用文件（但仍登记一条附件记录，便于按会话/消息引用）
    let existing_path: Option<String> = db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT file_path FROM attachment WHERE sha256 = ?1 AND file_path != '' LIMIT 1",
                [&sha],
                |r| r.get(0),
            )
            .optional()?)
    })?;
    let rel_path = match existing_path {
        Some(p) => p,
        None => {
            let now_prefix = &crate::util::now_db()[0..7].replace('-', "");
            let rel = PathBuf::from("attachments")
                .join(now_prefix)
                .join(&sha[0..2])
                .join(format!("{sha}.{}", ext_of(filename, mime)));
            let abs = data_dir.join(&rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if !abs.exists() {
                std::fs::write(&abs, bytes)?;
            }
            rel.to_string_lossy().replace('\\', "/")
        }
    };

    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let kind = if is_image { "image" } else { "table" };
    let now = now_db();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO attachment
               (id, session_id, kind, filename, mime, size, sha256, file_path, origin,
                reading_json, reading_method, reading_status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', '', 'none', ?10)",
            params![
                id,
                session_id,
                kind,
                filename,
                mime,
                bytes.len() as i64,
                sha,
                rel_path,
                origin,
                now,
            ],
        )?;
        Ok(())
    })?;
    let att = get(db, &id)?.ok_or_else(|| anyhow!("附件写入后读取失败"))?;
    Ok(json!({ "ok": true, "attachment": att.to_json() }))
}

const COLS: &str = "id, session_id, message_id, kind, filename, mime, size, sha256, width, height,
                    file_path, origin, reading_json, reading_method, reading_status, created_at";

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    let reading: String = r.get(12)?;
    Ok(Attachment {
        id: r.get(0)?,
        session_id: r.get(1)?,
        message_id: r.get(2)?,
        kind: r.get(3)?,
        filename: r.get(4)?,
        mime: r.get(5)?,
        size: r.get(6)?,
        sha256: r.get(7)?,
        width: r.get(8)?,
        height: r.get(9)?,
        file_path: r.get(10)?,
        origin: r.get(11)?,
        reading: serde_json::from_str(&reading).ok(),
        reading_method: r.get(13)?,
        reading_status: r.get(14)?,
        created_at: r.get(15)?,
    })
}

pub fn get(db: &Db, id: &str) -> Result<Option<Attachment>> {
    db.with(|conn| {
        Ok(conn
            .query_row(&format!("SELECT {COLS} FROM attachment WHERE id = ?1"), [id], map_row)
            .optional()?)
    })
}

pub fn list(db: &Db, session_id: Option<&str>, limit: i64) -> Result<Value> {
    let items = db.with(|conn| {
        let sql = match session_id {
            Some(_) => format!("SELECT {COLS} FROM attachment WHERE session_id = ?1 ORDER BY created_at DESC LIMIT ?2"),
            None => format!("SELECT {COLS} FROM attachment ORDER BY created_at DESC LIMIT ?1"),
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = match session_id {
            Some(sid) => stmt
                .query_map(params![sid, limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?,
            None => stmt.query_map(params![limit], map_row)?.collect::<Result<Vec<_>, _>>()?,
        };
        Ok(rows)
    })?;
    let json_items: Vec<Value> = items.iter().map(|a| a.to_json()).collect();
    Ok(json!({ "total": json_items.len(), "items": json_items }))
}

/// 附件挂到某条消息上（对话落库后回填）
pub fn bind_to_message(db: &Db, ids: &[String], session_id: &str, message_id: i64) -> Result<usize> {
    let mut n = 0;
    db.with(|conn| {
        for id in ids {
            n += conn.execute(
                "UPDATE attachment SET message_id = ?1, session_id = ?2 WHERE id = ?3",
                params![message_id, session_id, id],
            )?;
        }
        Ok(())
    })?;
    Ok(n)
}

/// 某条消息的附件（构建多模态消息用）
pub fn for_message(db: &Db, message_id: i64) -> Result<Vec<Attachment>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLS} FROM attachment WHERE message_id = ?1 ORDER BY created_at"
        ))?;
        let rows = stmt.query_map([message_id], map_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// 一批消息的附件（历史文本化用）
pub fn for_messages(db: &Db, message_ids: &[i64]) -> Result<Vec<Attachment>> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = message_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLS} FROM attachment WHERE message_id IN ({list}) ORDER BY message_id, created_at"
        ))?;
        let rows = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// 读取图片字节并转成 data URL（发给模型）
pub fn data_url(data_dir: &Path, att: &Attachment) -> Result<String> {
    let bytes = read_bytes(data_dir, att)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", att.mime, b64))
}

pub fn read_bytes(data_dir: &Path, att: &Attachment) -> Result<Vec<u8>> {
    if att.file_path.is_empty() {
        return Err(anyhow!("附件无文件路径：{}", att.id));
    }
    let abs = data_dir.join(&att.file_path);
    std::fs::read(&abs).map_err(|e| anyhow!("读取附件文件失败：{} ({e})", abs.display()))
}

/// 记录读取结果（Reading）
pub fn set_reading(db: &Db, id: &str, reading: &Value, method: &str, status: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE attachment SET reading_json = ?1, reading_method = ?2, reading_status = ?3 WHERE id = ?4",
            params![
                serde_json::to_string(reading).unwrap_or_else(|_| "{}".into()),
                method,
                status,
                id,
            ],
        )?;
        Ok(())
    })
}

pub fn delete(db: &Db, data_dir: &Path, id: &str) -> Result<Value> {
    let Some(att) = get(db, id)? else {
        return Ok(json!({ "error": format!("附件不存在: {id}") }));
    };
    db.with(|conn| {
        conn.execute("DELETE FROM attachment WHERE id = ?1", [id])?;
        Ok(())
    })?;
    // 内容寻址：还有别的记录引用同一文件时才保留文件
    let still_used: i64 = db.with(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM attachment WHERE file_path = ?1",
            [&att.file_path],
            |r| r.get(0),
        )?)
    })?;
    if still_used == 0 && !att.file_path.is_empty() {
        let _ = std::fs::remove_file(data_dir.join(&att.file_path));
    }
    Ok(json!({ "deleted": id }))
}

// ---------------------------------------------------------------------------
// Reading：视觉读取
// ---------------------------------------------------------------------------

/// 读取指令（按 schema 抽取）。保持提示词静态、可复用。
pub fn extract_prompt(target: &str) -> String {
    let base = "你是一名严谨的财务/公告信息抽取助手。请只依据图片内容作答，看不清或图片中不存在的内容不要猜测。\n\
                严格输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏。JSON 字段：\n\
                {\n\
                  \"kind\": \"table|text|keyvalue|image\",\n\
                  \"title\": \"这张图是什么（一句话）\",\n\
                  \"meta\": {\"unit\":\"万元|元|亿元|未知\",\"scope\":\"合并报表|母公司|未知\",\"period\":\"年份或报告期\"},\n\
                  \"fields\": [{\"label\":\"科目原名\",\"value\":数字或字符串,\"unit\":\"单位\",\"confidence\":0到1}],\n\
                  \"notes\": [\"识别过程中的不确定点，例如单位按表头推断\"],\n\
                  \"raw_text\": \"图片中最关键的原始文字（截断到 800 字以内）\"\n\
                }\n\
                要求：value 为数字时不要带千分位与货币符号，负数保留负号；confidence 反映你对这个数字的把握。";
    match target {
        "finance" => format!(
            "{base}\n本次目标：这是一张财务报表/财务指标表格截图，请抽取其中的科目与数值（fields 里 label 用图中的原始科目名）。"
        ),
        "announcement" => format!(
            "{base}\n本次目标：这是一张公告/判决书/新闻截图，请抽取关键事实（fields 里 label 用「主体」「事项」「金额」「日期」等），kind 用 text。"
        ),
        _ => format!("{base}\n本次目标：通用抽取。"),
    }
}

/// 从模型输出里提取 JSON（容忍 ```json 围栏与前后杂文）
pub fn extract_json(text: &str) -> Option<Value> {
    let mut body = text.trim().to_string();
    if let Some(start) = body.find("```") {
        let after = &body[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            body = after[..end].to_string();
        }
    }
    let s = body.find('{')?;
    let e = body.rfind('}')?;
    if e <= s {
        return None;
    }
    serde_json::from_str::<Value>(&body[s..=e]).ok().filter(|v| v.is_object())
}

/// 归一化模型返回：补齐字段、裁剪长度、统一置信度
pub fn normalize_reading(raw: &Value, method: &str) -> Value {
    let mut fields: Vec<Value> = Vec::new();
    for f in raw.get("fields").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let label = f.get("label").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if label.is_empty() {
            continue;
        }
        let value = f.get("value").cloned().unwrap_or(Value::Null);
        if value.is_null() {
            continue;
        }
        let field = crate::services::tables::match_field(&label)
            .map(|s| s.to_string())
            .unwrap_or_default();
        let confidence = f
            .get("confidence")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.7)
            .clamp(0.0, 1.0);
        fields.push(json!({
            "label": label,
            "field": field,
            "value": value,
            "unit": f.get("unit").and_then(|v| v.as_str()).unwrap_or(""),
            "confidence": (confidence * 100.0).round() / 100.0,
        }));
    }
    json!({
        "kind": raw.get("kind").and_then(|v| v.as_str()).unwrap_or("image"),
        "method": method,
        "confidence": fields
            .iter()
            .filter_map(|f| f.get("confidence").and_then(|v| v.as_f64()))
            .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |a: f64| a.min(v))))
            .unwrap_or(0.0),
        "title": raw.get("title").and_then(|v| v.as_str()).unwrap_or("").chars().take(120).collect::<String>(),
        "meta": raw.get("meta").cloned().unwrap_or(json!({})),
        "fields": fields,
        "notes": raw.get("notes").cloned().unwrap_or(json!([])),
        "raw_text": raw.get("raw_text").and_then(|v| v.as_str()).unwrap_or("").chars().take(2000).collect::<String>(),
    })
}

/// 把 Reading 的 fields 映射成表格单元格（供 TableDoc 填充）
pub fn reading_to_cells(reading: &Value) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for f in reading.get("fields").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let field = f.get("field").and_then(|v| v.as_str()).unwrap_or("");
        if field.is_empty() {
            continue;
        }
        let value = match f.get("value") {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => s.trim().replace(',', "").parse::<f64>().ok(),
            _ => None,
        };
        if let Some(v) = value {
            out.push((field.to_string(), v));
        }
    }
    out
}

/// 阅读结果摘要（给对话/工具结果用，避免上下文膨胀）
#[allow(dead_code)]
pub fn reading_brief(att: &Attachment) -> Value {
    let reading = att.reading.clone().unwrap_or(json!({}));
    json!({
        "attachment_id": att.id,
        "filename": att.filename,
        "kind": att.kind,
        "reading_status": att.reading_status,
        "method": att.reading_method,
        "title": reading.get("title"),
        "meta": reading.get("meta"),
        "confidence": reading.get("confidence"),
        "fields": reading.get("fields").cloned().unwrap_or(json!([])),
        "notes": reading.get("notes").cloned().unwrap_or(json!([])),
    })
}

/// 汇总某会话的附件（前端上传后回显）
#[allow(dead_code)]
pub fn id_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 从 reading 里取企业/期间线索（用于自动填表的元数据）
#[allow(dead_code)]
pub fn reading_meta(reading: &Value) -> Map<String, Value> {
    reading
        .get("meta")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

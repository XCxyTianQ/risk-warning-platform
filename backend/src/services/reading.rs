//! 多模态「读取」：把附件（图片）交给视觉模型抽取成结构化 Reading，并可选填入表格。
//!
//! 与 Python 版的关系：Python 期只有 `probe_vision.py` 探针（直接打 OpenAI 兼容端点，
//! 输出严格 JSON），这里把它产品化：指令静态可复用、结果落库（Reading）、
//! 与表格对象/勾稽校验/证据链打通。

use anyhow::Result;
use serde_json::{json, Value};

use crate::llm::{LlmClient, LlmConfig};
use crate::services::attachments::{self, Attachment};
use crate::state::AppState;

fn client_for(state: &AppState) -> LlmClient {
    let rt = state.rt();
    LlmClient::new(LlmConfig {
        base_url: rt.llm_base_url.clone(),
        api_key: rt.llm_api_key.clone(),
        model: rt.llm_model.clone(),
        max_tokens: rt.llm_analysis_max_tokens.min(4096),
        timeout_s: 90,
        max_retries: 1,
        disable_thinking: rt.llm_disable_thinking,
    })
}

/// 读取一个附件：视觉抽取 → 归一化 Reading → 落库（可选填表）
pub async fn read_attachment(
    state: &AppState,
    attachment_id: &str,
    target: &str,
    table_id: Option<i64>,
    dry_run: bool,
) -> Result<Value> {
    let Some(att) = attachments::get(&state.db, attachment_id)? else {
        return Ok(json!({ "error": format!("附件不存在: {attachment_id}") }));
    };
    if att.kind != "image" {
        return Ok(json!({
            "error": format!("附件「{}」不是图片（当前视觉读取仅支持图片；表格文件请走确定性解析）", att.filename),
        }));
    }

    let data_url = attachments::data_url(&state.cfg.data_dir, &att)?;
    let prompt = attachments::extract_prompt(target);
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "text", "text": prompt },
            { "type": "image_url", "image_url": { "url": data_url } },
        ],
    })];

    let client = client_for(state);
    let reply = client
        .chat(messages, vec![], None)
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let text = reply.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let usage = client.last_usage();
    let timing = client.last_timing();

    let parsed = attachments::extract_json(&text);
    let reading = match &parsed {
        Some(raw) => attachments::normalize_reading(raw, "vision"),
        None => json!({
            "kind": "image",
            "method": "vision",
            "confidence": 0.0,
            "title": "",
            "meta": {},
            "fields": [],
            "notes": ["模型未返回可解析的 JSON，请查看 raw_text"],
            "raw_text": text.chars().take(2000).collect::<String>(),
        }),
    };

    if !dry_run {
        let status = if parsed.is_some() { "ok" } else { "error" };
        attachments::set_reading(&state.db, attachment_id, &reading, "vision", status)?;
    }

    // 可选：把识别结果直接填进表格（视觉来源的单元格需人工确认后才允许入库）
    let mut fill: Option<Value> = None;
    if let Some(tid) = table_id {
        fill = Some(fill_table_from_reading(state, tid, &reading, attachment_id)?);
    }

    Ok(json!({
        "ok": true,
        "attachment": attachments::get(&state.db, attachment_id)?.map(|a| a.to_json()),
        "reading": reading,
        "fill": fill,
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "cache_hit_tokens": usage.cache_hit_tokens,
            "cache_miss_tokens": usage.cache_miss_tokens,
        },
        "timing": { "latency_ms": timing.latency_ms, "ttft_ms": timing.ttft_ms },
        "raw_text": reading.get("raw_text").cloned().unwrap_or(json!("")),
    }))
}

/// 把 Reading 的字段写进表格：只填**已映射到引擎字段**的科目，标记来源为 vision（待确认）
pub fn fill_table_from_reading(
    state: &AppState,
    table_id: i64,
    reading: &Value,
    attachment_id: &str,
) -> Result<Value> {
    let Some(doc) = crate::services::tables::get(&state.db, table_id)? else {
        return Ok(json!({ "error": format!("表格不存在: {table_id}") }));
    };
    let Some(first_col) = doc.sheet.get("columns").and_then(|v| v.as_array()).and_then(|a| a.first()) else {
        return Ok(json!({ "error": "表格没有期间列，无法填充" }));
    };
    let col = first_col.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let pairs = attachments::reading_to_cells(reading);
    if pairs.is_empty() {
        return Ok(json!({
            "ok": false,
            "written": 0,
            "note": "识别结果里没有可映射的财务科目（可能不是财报表格，或科目名不在别名词典中）",
        }));
    }

    // 行 key 查表：按映射找行，找不到就按字段标签匹配/新建行
    let mapping = doc.mapping.clone();
    let mut written = 0usize;
    let mut skipped: Vec<Value> = Vec::new();
    for (field, value) in pairs {
        let row_key = mapping
            .get(&field)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let Some(row_key) = row_key else {
            skipped.push(json!({ "field": field, "value": value, "reason": "表格中无对应科目行" }));
            continue;
        };
        // 单位换算：表格单位与识别单位可能不同（识别 meta.unit 与表头 unit 都可能是万元/元）
        let factor = unit_factor(reading, &doc.unit);
        let scaled = ((value * factor) * 10_000.0).round() / 10_000.0;
        crate::services::tables::write_cells(
            &state.db,
            table_id,
            &json!({
                "row": row_key,
                "col": col,
                "value": scaled,
                "source": "vision",
                "confidence": 0.6,
            }),
        )?;
        written += 1;
    }

    Ok(json!({
        "ok": true,
        "table_id": table_id,
        "col": col,
        "written": written,
        "skipped": skipped,
        "attachment_id": attachment_id,
        "note": "识别结果为待确认状态（source=vision），确认后方可入库",
    }))
}

/// 识别单位 → 表格单位 的换算系数
fn unit_factor(reading: &Value, table_unit: &str) -> f64 {
    let read_unit = reading
        .get("meta")
        .and_then(|m| m.get("unit"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let to_wan = |u: &str| match u {
        "元" => 0.0001,
        "亿元" => 10_000.0,
        _ => 1.0,
    };
    if read_unit.is_empty() || read_unit == "未知" {
        return 1.0;
    }
    to_wan(read_unit) / to_wan(table_unit)
}

/// 读取结果摘要（供工具返回）
#[allow(dead_code)]
pub fn brief(att: &Attachment) -> Value {
    attachments::reading_brief(att)
}

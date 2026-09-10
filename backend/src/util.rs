//! 通用小工具（跨模块复用）。

use std::time::{SystemTime, UNIX_EPOCH};

/// 当前 UTC 时间：SQLAlchemy `DateTime` 在 SQLite 中的文本形态
/// （naive，毫秒/微秒用 `.` 分隔，与 Python 端 `datetime.utcnow()` 落库一致）。
///
/// 两个后端共用同一个库文件，时间字符串必须同形，否则会出现
/// "2026-09-08 12:09" 与 "2026-09-08T12:09" 混存、排序与显示不一致。
pub fn now_db() -> String {
    let (secs, micros) = now_parts();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}.{micros:06}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 当前 UTC 时间（ISO8601，`T` 分隔）——用于非落库字段（如 `exported_at`）
pub fn now_iso() -> String {
    db_to_iso(&now_db())
}

/// 读库时间 → ISO8601：把首个空格换成 `T`（对齐 Python `.isoformat()` 的输出）
pub fn db_to_iso(value: &str) -> String {
    value.replacen(' ', "T", 1)
}

/// 可选字段版本：`None` 原样返回
pub fn opt_db_to_iso(value: Option<String>) -> Option<String> {
    value.map(|v| db_to_iso(&v))
}

fn now_parts() -> (i64, u32) {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64, d.subsec_micros()),
        Err(_) => (0, 0),
    }
}

/// 纪元秒 → `YYYY-MM-DDTHH:MM:SS`（UTC，诊断用）
#[allow(dead_code)]
pub fn format_iso(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
}

/// 纪元秒 → `YYYY-MM-DD`（诊断/日期字段用）
#[allow(dead_code)]
pub fn format_date(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant 的 civil_from_days 算法（1970-01-01 起的天数 → 年月日）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 股票代码归一：600519 / SH600519 / sh.600519 / 600519.SH / 000001.XSHE → 600519
pub fn normalize_code(raw: &str) -> Option<String> {
    let s: String = raw
        .trim()
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if s.is_empty() {
        return None;
    }
    let stripped = s
        .strip_prefix("SH")
        .or_else(|| s.strip_prefix("SZ"))
        .or_else(|| s.strip_prefix("BJ"))
        .or_else(|| s.strip_prefix("SS"))
        .unwrap_or(&s)
        .trim_start_matches('.');
    let core = stripped
        .strip_suffix(".SH")
        .or_else(|| stripped.strip_suffix(".SZ"))
        .or_else(|| stripped.strip_suffix(".BJ"))
        .or_else(|| stripped.strip_suffix(".SS"))
        .or_else(|| stripped.strip_suffix(".XSHE"))
        .or_else(|| stripped.strip_suffix(".XSHG"))
        .unwrap_or(stripped);
    if core.len() == 6 && core.chars().all(|c| c.is_ascii_digit()) {
        Some(core.to_string())
    } else {
        None
    }
}

//! 通用小工具（跨模块复用）。

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

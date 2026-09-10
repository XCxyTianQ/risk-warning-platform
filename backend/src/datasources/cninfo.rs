//! 巨潮资讯数据源：公司治理-公司诉讼统计。
//!
//! 接口需要动态 `Accept-Enckey`：
//!   AES-128-CBC(当前秒数, key = iv = "1234567887654321", PKCS7) → Base64
//! （与 akshare 通过 py_mini_racer 执行 cninfo.js 得到的结果一致）

use std::time::{SystemTime, UNIX_EPOCH};

use cbc::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
use base64::Engine;

use super::http::post_json;
use super::{FetchResult, LegalRecord};

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

const URL: &str = "https://webapi.cninfo.com.cn/api/sysapi/p_sysapi1055";

/// 板块 → 巨潮 market 参数（与 Python 版 `_board_of` 对齐）
pub fn board_market(code: &str) -> &'static str {
    if code.starts_with("688") {
        "012029" // 科创板
    } else if code.starts_with("300") || code.starts_with("301") {
        "012015" // 创业板
    } else if code.starts_with('6') {
        "012001" // 沪市
    } else {
        "012002" // 深市主板
    }
}

fn accept_enckey() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = b"1234567887654321";
    let iv = b"1234567887654321";
    let cipher = Aes128CbcEnc::new(key.into(), iv.into());
    let ciphertext = cipher.encrypt_padded_vec::<Pkcs7>(secs.to_string().as_bytes());
    base64::engine::general_purpose::STANDARD.encode(ciphertext)
}

fn date_str(days_ago: i64) -> String {
    (chrono::Local::now().date_naive() - chrono::Duration::days(days_ago))
        .format("%Y-%m-%d")
        .to_string()
}

/// 诊断用：返回巨潮原始响应（前若干字符），用于核对 records 结构
pub async fn debug_raw(code: &str) -> anyhow::Result<String> {
    let end = chrono::Local::now().date_naive();
    let start = end - chrono::Duration::days(540);
    let enckey = accept_enckey();
    let value = post_json(
        URL,
        &[
            ("sdate", &start.format("%Y-%m-%d").to_string()),
            ("edate", &end.format("%Y-%m-%d").to_string()),
            ("market", board_market(code)),
        ],
        &[
            ("Accept", "*/*"),
            ("Accept-Enckey", &enckey),
            ("Origin", "https://webapi.cninfo.com.cn"),
            ("Referer", "https://webapi.cninfo.com.cn/"),
            ("X-Requested-With", "XMLHttpRequest"),
        ],
    )
    .await?;
    Ok(value.to_string())
}

/// 拉取公司诉讼统计（默认近 540 天）
pub async fn fetch_legal(code: &str, days: i64) -> FetchResult {
    let mut result = FetchResult {
        dimension: "legal".into(),
        source: "巨潮资讯/公司诉讼统计".into(),
        ..Default::default()
    };
    let end = chrono::Local::now().date_naive();
    let start = end - chrono::Duration::days(days);
    let (sdate, edate) = (
        start.format("%Y-%m-%d").to_string(),
        end.format("%Y-%m-%d").to_string(),
    );
    let enckey = accept_enckey();
    let data = match post_json(
        URL,
        &[("sdate", &sdate), ("edate", &edate), ("market", board_market(code))],
        &[
            ("Accept", "*/*"),
            ("Accept-Enckey", &enckey),
            ("Origin", "https://webapi.cninfo.com.cn"),
            ("Referer", "https://webapi.cninfo.com.cn/"),
            ("X-Requested-With", "XMLHttpRequest"),
        ],
    )
    .await
    {
        Ok(v) => v,
        Err(err) => {
            result.error = Some(format!("巨潮接口失败：{err}"));
            return result;
        }
    };

    let records = data.get("records").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if records.is_empty() {
        result.gap = Some("公告期内无诉讼记录（正常）".into());
        return result;
    }

    // records 为对象数组：
    //   {"AINTERVAL":"公告统计区间","F001N":诉讼次数,"F002N":诉讼金额(万元),"SECCODE":"证券代码","SECNAME":"证券简称"}
    for rec in records {
        let sec_code = rec
            .get("SECCODE")
            .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))
            .unwrap_or_default();
        let sec_code = sec_code.trim_matches('"').to_string();
        if sec_code != code {
            continue;
        }
        let period = rec.get("AINTERVAL").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let amount = rec.get("F002N").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let count = rec.get("F001N").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;

        result.legal.push(LegalRecord {
            case_no: String::new(),
            doc_type: "诉讼统计".into(),
            title: format!("公告期内诉讼 {count} 次（{period}）"),
            court: "巨潮资讯统计".into(),
            cause: "诉讼统计（公开披露汇总）".into(),
            amount,
            status: format!("统计口径：{period}"),
            judgment_date: date_str(0),
            source: "巨潮资讯（公开披露）".into(),
        });
    }
    if result.legal.is_empty() {
        result.gap = Some("公告期内该代码无诉讼记录".into());
    }
    result
}

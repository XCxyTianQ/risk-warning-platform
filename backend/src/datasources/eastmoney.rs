//! 东方财富数据源：
//! - 个股公告（`np-anotice-stock`，舆情维度的第二信源，含问询函/立案/处罚等强风险信号）
//! - A 股代码-名称对照（`push2 clist` 全市场快照，单次请求覆盖全部代码）

use std::collections::BTreeMap;

use anyhow::Result;
use serde_json::Value;

use super::http::{get_json, get_json_h};
use super::{classify_sentiment, FetchResult, NewsRecord};

const NOTICE_URL: &str = "https://np-anotice-stock.eastmoney.com/api/security/ann";
// push2 为多镜像负载均衡：主域偶发限流/断连，按序回退（与 AkShare 使用 1./82. 镜像一致）
const CLIST_HOSTS: [&str; 4] = [
    "https://1.push2.eastmoney.com/api/qt/clist/get",
    "https://push2delay.eastmoney.com/api/qt/clist/get",
    "https://82.push2.eastmoney.com/api/qt/clist/get",
    "https://push2.eastmoney.com/api/qt/clist/get",
];
const QUOTE_REFERER: &str = "https://quote.eastmoney.com/";

/// 个股公告 → 舆情记录（标题前缀 [公告]，情感用关键词规则）
pub async fn fetch_news(code: &str, limit: usize) -> FetchResult {
    let mut result = FetchResult {
        dimension: "news".into(),
        source: "东方财富/公告".into(),
        ..Default::default()
    };
    let data = match get_json(
        NOTICE_URL,
        &[
            ("sr", "-1"),
            ("page_size", &limit.to_string()),
            ("page_index", "1"),
            ("ann_type", "A"),
            ("client_source", "web"),
            ("f_node", "0"),
            ("s_node", "0"),
            ("stock_list", code),
        ],
    )
    .await
    {
        Ok(v) => v,
        Err(err) => {
            result.error = Some(format!("公告接口失败：{err}"));
            return result;
        }
    };

    let list = data
        .get("data")
        .and_then(|d| d.get("list"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for item in list.iter().take(limit) {
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let art_code = item.get("art_code").and_then(|v| v.as_str()).unwrap_or("");
        let notice_date = item
            .get("notice_date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(10)
            .collect::<String>();
        let url = if art_code.is_empty() {
            String::new()
        } else {
            format!("https://data.eastmoney.com/notices/detail/{code}/{art_code}.html")
        };
        result.news.push(NewsRecord {
            title: format!("[公告] {title}").chars().take(300).collect(),
            content: "公告类型：其他".into(),
            source: "东方财富公告".into(),
            url: url.chars().take(400).collect(),
            published_at: notice_date,
            sentiment: classify_sentiment(&title).into(),
        });
    }
    if result.news.is_empty() {
        result.gap = Some("该代码暂无公告记录".into());
    }
    result
}

/// 单只股票：代码 → 证券简称（按需查询，避免批量拉全市场被限流）
pub async fn fetch_stock_name(code: &str) -> Result<String> {
    let market = if code.starts_with('6') || code.starts_with('9') { "1" } else { "0" };
    let data = get_json_h(
        "https://1.push2.eastmoney.com/api/qt/stock/get",
        &[("secid", &format!("{market}.{code}")), ("fields", "f57,f58")],
        &[("Referer", QUOTE_REFERER)],
    )
    .await?;
    let name = data
        .get("data")
        .and_then(|d| d.get("f58"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if name.is_empty() {
        anyhow::bail!("未找到股票代码 {code} 对应的证券简称");
    }
    Ok(name.to_string())
}

/// 关键词 → 证券候选（东财搜索建议，只保留 A 股）
pub async fn suggest(keyword: &str, limit: usize) -> Result<Vec<(String, String)>> {
    let data = get_json_h(
        "https://searchapi.eastmoney.com/api/suggest/get",
        &[
            ("input", keyword),
            ("type", "14"),
            ("token", "D43BF722C8E33BDC906FB84D85E326E8"),
            ("count", &limit.to_string()),
        ],
        &[("Referer", QUOTE_REFERER)],
    )
    .await?;
    let rows = data
        .get("QuotationCodeTable")
        .and_then(|t| t.get("Data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for row in rows {
        let classify = row.get("Classify").and_then(|v| v.as_str()).unwrap_or("");
        if classify != "AStock" {
            continue;
        }
        let code = row.get("Code").and_then(|v| v.as_str()).unwrap_or("");
        let name = row.get("Name").and_then(|v| v.as_str()).unwrap_or("");
        if !code.is_empty() && !name.is_empty() {
            out.push((code.to_string(), name.to_string()));
        }
    }
    Ok(out)
}

/// A 股代码 → 简称（优先单次大分页请求；不足时再分页补齐）
pub async fn fetch_code_table() -> Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    // 一次请求尽量覆盖全市场（6000 上限），并从多个镜像中挑选可用者
    let base_params: Vec<(&str, &str)> = vec![
        ("pn", "1"),
        ("pz", "6000"),
        ("po", "1"),
        ("np", "1"),
        ("fltt", "2"),
        ("invt", "2"),
        ("fid", "f12"),
        ("fs", "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"),
        ("fields", "f12,f14"),
    ];
    let mut first: Option<Value> = None;
    let mut last_err: Option<anyhow::Error> = None;
    for host in CLIST_HOSTS {
        match get_json_h(host, &base_params, &[("Referer", QUOTE_REFERER)]).await {
            Ok(v) => {
                first = Some(v);
                break;
            }
            Err(err) => last_err = Some(err),
        }
    }
    let data = first.ok_or_else(|| last_err.unwrap_or_else(|| anyhow::anyhow!("代码表全部镜像不可用")))?;
    let total;
    if let Some(diff) = data.get("data").and_then(|d| d.get("diff")).and_then(|v| v.as_array()) {
        for item in diff {
            let code = item.get("f12").and_then(|v| v.as_str()).unwrap_or("");
            let name = item.get("f14").and_then(|v| v.as_str()).unwrap_or("");
            if !code.is_empty() && !name.is_empty() {
                map.insert(code.to_string(), name.to_string());
            }
        }
    }
    total = data
        .get("data")
        .and_then(|d| d.get("total"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // 分页补齐（每页之间稍作停顿，降低被风控概率）
    let mut page = 2;
    while (map.len() as i64) < total && page <= 10 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let mut page_data: Option<Value> = None;
        let page_str = page.to_string();
        for host in CLIST_HOSTS {
            let params: Vec<(&str, &str)> = vec![
                ("pn", page_str.as_str()),
                ("pz", "1000"),
                ("po", "1"),
                ("np", "1"),
                ("fltt", "2"),
                ("invt", "2"),
                ("fid", "f12"),
                ("fs", "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"),
                ("fields", "f12,f14"),
            ];
            if let Ok(v) = get_json_h(host, &params, &[("Referer", QUOTE_REFERER)]).await {
                page_data = Some(v);
                break;
            }
        }
        let data = match page_data {
            Some(v) => v,
            None => break, // 单页失败不阻断：已有部分代码表仍可用
        };
        let diff = data
            .get("data")
            .and_then(|d| d.get("diff"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if diff.is_empty() {
            break;
        }
        for item in &diff {
            let code = item.get("f12").and_then(|v| v.as_str()).unwrap_or("");
            let name = item.get("f14").and_then(|v| v.as_str()).unwrap_or("");
            if !code.is_empty() && !name.is_empty() {
                map.insert(code.to_string(), name.to_string());
            }
        }
        page += 1;
    }
    Ok(map)
}

/// 单只个股的行情快照（预留：市值口径 Altman Z 需要总市值）
#[allow(dead_code)]
pub async fn fetch_market_cap(code: &str) -> Result<f64> {
    let data = get_json(
        "https://push2.eastmoney.com/api/qt/stock/get",
        &[("secid", &format!("{}.{}", if code.starts_with('6') { 1 } else { 0 }, code)), ("fields", "f116")],
    )
    .await?;
    let cap = data
        .get("data")
        .and_then(|d| d.get("f116"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let _: Option<&Value> = None;
    Ok(cap / 1e4)
}

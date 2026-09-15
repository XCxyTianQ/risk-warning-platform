//! 行业板块与行情数据（数据源：东方财富公开接口）。
//!
//! 补这个模块的原因：任务级测评第 1 题暴露了能力缺口——平台的 25 个工具全部面向
//! "已建档企业之后的分析"，而用户的真实需求第一步是"**先找到该分析什么**"
//! （行业板块成分股 + 市值排序 + 行情估值）。这里把这前半段补上。
//!
//! 口径说明（写进工具描述，避免模型误用）：
//! - 板块采用东方财富行业板块分类（如「贵金属」BK0732），**不是**概念板块；
//!   两者成分股不同（例：紫金矿业属工业金属/铜，不在贵金属板块内）；
//! - 市值、PE、PB 为接口实时快照，非财报口径。

use crate::datasources::http::{get_json, get_json_h};
use serde_json::{json, Value};

/// 东方财富行情接口对 `clist` 要求带 Referer/UA，否则返回失败；
/// `ulist.np`（个股快照）不要求，这就是"同主机一个通一个不通"的原因。
const HDRS: [(&str, &str); 2] = [
    ("Referer", "https://quote.eastmoney.com/"),
    ("User-Agent", "Mozilla/5.0"),
];

/// clist 端点的可用主机（**带回退**）。
///
/// 实测（2026-09-15）：`push2.eastmoney.com` 及其全部编号镜像（1./7./82.）从本机
/// 均 `fetch failed`，而 `push2delay.eastmoney.com` 正常返回——即实时行情主机被挡/不可达，
/// 延时行情主机可用。因此这里按顺序回退，并把实际使用的数据源写进返回值（延时≠实时，必须标注）。
const CLIST_HOSTS: [&str; 2] = [
    "https://push2.eastmoney.com",
    "https://push2delay.eastmoney.com",
];

/// 依次尝试各主机，返回第一个**确实带数据**的结果。
async fn clist_get(query: &str) -> anyhow::Result<(Value, &'static str)> {
    let mut last: Option<anyhow::Error> = None;
    for host in CLIST_HOSTS {
        let url = format!("{host}{query}");
        match get_json_raw(&url).await {
            Ok(v) => {
                let has = v
                    .get("data")
                    .and_then(|d| d.get("diff"))
                    .map(|d| !d.is_null())
                    .unwrap_or(false);
                if has {
                    return Ok((v, host));
                }
                last = Some(anyhow::anyhow!("{host} 返回空数据"));
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("所有行情主机均失败")))
}

/// 直接发裸 URL 的 GET（**不经过 `.query()`**）。
///
/// 为什么不用现成的 `datasources::http::get_json`：它内部是 `client().get(url).query(params)`，
/// 而 reqwest 的 `.query()` 会经 `query_pairs_mut()` **重解析并重新序列化已有查询串**——
/// 即使传入空数组，`fs=b:BK0732` 里的 `:` 也会被写成 `%3A`，东财据此判定筛选条件无效而失败。
/// 同一条 URL 在 Node 里裸拼字符串可以直接取到数据，差异就在这里。
/// 本函数只做 GET+JSON 解析，带 Referer/UA，含一次重试与 20s 超时。
async fn get_json_raw(url: &str) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let mut last: Option<anyhow::Error> = None;
    for attempt in 1..=2 {
        let mut req = client.get(url);
        for (k, v) in HDRS {
            req = req.header(k, v);
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if !status.is_success() {
                    last = Some(anyhow::anyhow!("HTTP {}：{}", status.as_u16(), text.chars().take(160).collect::<String>()));
                } else {
                    match serde_json::from_str::<Value>(&text) {
                        Ok(v) => return Ok(v),
                        Err(e) => last = Some(anyhow::anyhow!("响应非 JSON（前 160 字）：{}｜{}", text.chars().take(160).collect::<String>(), e)),
                    }
                }
            }
            Err(e) => last = Some(anyhow::anyhow!("{e}")),
        }
        if attempt == 1 {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("请求失败：{url}")))
}

const CLIST: &str = "https://push2.eastmoney.com/api/qt/clist/get";
const ULIST: &str = "https://push2.eastmoney.com/api/qt/ulist.np/get";

/// 行情+估值字段（东方财富 f-字段）：
/// f12 代码 f14 名称 f2 最新价 f3 涨跌幅 f9 市盈率(动) f20 总市值 f21 流通市值 f23 市净率
const QUOTE_FIELDS: &str = "f12,f14,f2,f3,f9,f20,f21,f23";

fn to_yi(v: &Value) -> Value {
    match v.as_f64() {
        Some(x) => json!(format!("{:.1}", x / 1e8)),
        None => Value::Null,
    }
}

/// 行业板块列表（名称 + 代码 + 涨跌幅），用于确定"某行业"对应哪个板块。
///
/// 注意：这里**预拼完整 URL 并传空参数**。原因是 `datasources::http::get_json` 内部用
/// `reqwest` 的 `.query()`，它会把 `fs=m:90+t:2` 里的 `+` 编码成 `%2B`，东财不认这个筛选条件，
/// 表现为"请求失败"。同一条 URL 在 Node 侧直接拼字符串可以正常返回——差异就在编码。
pub async fn industry_boards(keyword: &str) -> Value {
    // 关键修正（实测踩过）：延时主机**每页硬上限 100 条**，若只取一页且按涨跌幅排序，
    // 「贵金属」这类排名靠后的板块会取不到，表现为"平台没有这个板块"。因此：
    // ① 行业(t:2) 与概念(t:3) 都查——东财把「贵金属」归在概念口径，用户说的板块可能落在任一边；
    // ② 按页码翻页取全量（最多 4 页 = 400 个板块），而不是只取第一页。
    let mut rows: Vec<Value> = Vec::new();
    let mut host = CLIST_HOSTS[0];
    for (kind, fs) in [("行业", "m:90+t:2"), ("概念", "m:90+t:3")] {
        for pn in 1..=4 {
            let query = format!(
                "/api/qt/clist/get?pn={pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs={fs}&fields=f12,f14,f3,f104,f105"
            );
            match clist_get(&query).await {
                Ok((v, h)) => {
                    host = h;
                    let page = v
                        .get("data")
                        .and_then(|d| d.get("diff"))
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let n = page.len();
                    for mut r in page {
                        if let Some(o) = r.as_object_mut() {
                            o.insert("board_type".to_string(), json!(kind));
                        }
                        rows.push(r);
                    }
                    if n < 100 {
                        break; // 已到末页
                    }
                }
                Err(e) => {
                    if rows.is_empty() && pn == 1 {
                        return json!({ "error": format!("板块列表获取失败: {e}") });
                    }
                    break;
                }
            }
        }
    }
    let kw = keyword.trim();
    let list: Vec<Value> = rows
        .iter()
        .filter(|r| kw.is_empty() || r.get("f14").and_then(|x| x.as_str()).map(|s| s.contains(kw)).unwrap_or(false))
        .map(|r| {
            json!({
                "board_code": r.get("f12"),
                "board_name": r.get("f14"),
                "change_pct": r.get("f3"),
                "up_count": r.get("f104"),
                "down_count": r.get("f105"),
            })
        })
        .collect();
    json!({
        "kind": "industry_board_list",
        "source_host": host,
        "data_timing": if host.contains("delay") { "延时行情（实时行情主机不可达时的回退数据源）" } else { "实时行情" },
        "board_types_included": ["行业", "概念"],
        "keyword": kw,
        "count": list.len(),
        "boards": list,
        "note": "这是东方财富行业板块分类，成分股固定；若用户说的行业更宽（如“黄金概念”），需要另行说明口径差异。",
    })
}

/// 板块成分股，按总市值降序。`board` 可以是板块代码（BK0732）或板块名称（贵金属）。
pub async fn board_constituents(board: &str, limit: usize) -> Value {
    let key = board.trim();
    if key.is_empty() {
        return json!({ "error": "需要提供板块代码或名称，例如 BK0732 或 贵金属" });
    }
    // 名称 → 代码
    let mut board_code = key.to_string();
    let mut board_name = String::new();
    if !key.to_uppercase().starts_with("BK") {
        let boards = industry_boards(key).await;
        let hit = boards
            .get("boards")
            .and_then(|b| b.as_array())
            .and_then(|a| a.iter().find(|x| x.get("board_name").and_then(|n| n.as_str()) == Some(key)))
            .cloned();
        match hit {
            Some(h) => {
                board_code = h.get("board_code").and_then(|x| x.as_str()).unwrap_or("").to_string();
                board_name = key.to_string();
            }
            None => {
                return json!({
                    "error": format!("未找到板块「{key}」，可先用 list_industry_boards 查询准确名称"),
                    "candidates": boards.get("boards").cloned().unwrap_or(json!([])),
                })
            }
        }
    }
    // 同 industry_boards：必须预拼 URL，避免 `.query()` 把 fs 里的字符编码掉
    let pz = limit.max(1).to_string();
    let query = format!(
        "/api/qt/clist/get?pn=1&pz={pz}&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:{board_code}&fields={QUOTE_FIELDS}"
    );
    let (v, host) = match clist_get(&query).await {
        Ok(x) => x,
        Err(e) => return json!({ "error": format!("成分股获取失败: {e}") }),
    };
    let rows = v
        .get("data")
        .and_then(|d| d.get("diff"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let total = v.get("data").and_then(|d| d.get("total")).and_then(|t| t.as_i64()).unwrap_or(rows.len() as i64);
    let list: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            json!({
                "rank": i + 1,
                "code": r.get("f12"),
                "name": r.get("f14"),
                "price": r.get("f2"),
                "change_pct": r.get("f3"),
                "pe_ttm": r.get("f9"),
                "pb": r.get("f23"),
                "total_mktcap_yi": to_yi(r.get("f20").unwrap_or(&Value::Null)),
                "float_mktcap_yi": to_yi(r.get("f21").unwrap_or(&Value::Null)),
            })
        })
        .collect();
    json!({
        "kind": "board_constituents",
        "source_host": host,
        "data_timing": if host.contains("delay") { "延时行情（实时主机不可达时的回退）" } else { "实时行情" },
        "board_code": board_code,
        "board_name": if board_name.is_empty() { Value::Null } else { json!(board_name) },
        "total_constituents": total,
        "returned": list.len(),
        "sorted_by": "total_mktcap desc",
        "unit": "市值单位为亿元，为接口实时快照；PE/PB 为行情口径，非财报口径",
        "stocks": list,
    })
}

/// 个股行情与估值快照（可一次多只）。代码需 6 位；自动判断沪(1)/深(0)。
pub async fn stock_snapshot(codes: &[String]) -> Value {
    let mut secids: Vec<String> = Vec::new();
    for c in codes {
        let d: String = c.chars().filter(|ch| ch.is_ascii_digit()).collect();
        if d.len() != 6 {
            continue;
        }
        let market = if d.starts_with('6') || d.starts_with("900") { "1" } else { "0" };
        secids.push(format!("{market}.{d}"));
    }
    if secids.is_empty() {
        return json!({ "error": "未提供有效的 6 位股票代码" });
    }
    let secid = secids.join(",");
    let params: Vec<(&str, &str)> = vec![
        ("fltt", "2"),
        ("invt", "2"),
        ("secids", &secid),
        ("fields", QUOTE_FIELDS),
    ];
    let v = match get_json(ULIST, &params).await {
        Ok(v) => v,
        Err(e) => return json!({ "error": format!("行情获取失败: {e}") }),
    };
    let rows = v
        .get("data")
        .and_then(|d| d.get("diff"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "code": r.get("f12"),
                "name": r.get("f14"),
                "price": r.get("f2"),
                "change_pct": r.get("f3"),
                "pe_ttm": r.get("f9"),
                "pb": r.get("f23"),
                "total_mktcap_yi": to_yi(r.get("f20").unwrap_or(&Value::Null)),
                "float_mktcap_yi": to_yi(r.get("f21").unwrap_or(&Value::Null)),
            })
        })
        .collect();
    json!({
        "kind": "stock_snapshot",
        "requested": secids.len(),
        "returned": list.len(),
        "unit": "市值单位为亿元，接口实时快照",
        "stocks": list,
    })
}

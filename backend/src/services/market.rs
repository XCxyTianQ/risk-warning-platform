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

use crate::datasources::http::get_json;
use serde_json::{json, Value};

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
    let url = format!(
        "{CLIST}?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3,f104,f105"
    );
    let v = match get_json(&url, &[]).await {
        Ok(v) => v,
        Err(e) => return json!({ "error": format!("板块列表获取失败: {e}") }),
    };
    let rows = v
        .get("data")
        .and_then(|d| d.get("diff"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
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
    let url = format!(
        "{CLIST}?pn=1&pz={pz}&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:{board_code}&fields={QUOTE_FIELDS}"
    );
    let v = match get_json(&url, &[]).await {
        Ok(v) => v,
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

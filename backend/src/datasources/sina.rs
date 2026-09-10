//! 新浪财经数据源（不依赖 akshare/pandas）：
//! - `source=gjzb`：财务关键指标（约 80 项，按报告期）
//! - `source=fzb|lrb|llb`：资产负债表 / 利润表 / 现金流量表（绝对值科目）
//!
//! 单位：源数据为元 → 万元；比率类保留百分比原值。

use anyhow::Result;
use serde_json::{json, Map, Value};

use super::http::get_json;
use super::{item_value, market_prefix, FinanceRecord, FetchResult, BALANCE_ITEMS, CASHFLOW_ITEMS, FINANCE_METRICS, INCOME_ITEMS};

const URL: &str = "https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022";

/// 取新浪某份报表的 {报告期: 该期条目数组}
async fn fetch_report(code: &str, source: &str) -> Result<Map<String, Value>> {
    let paper = market_prefix(code);
    let data = get_json(
        URL,
        &[
            ("paperCode", &paper),
            ("source", source),
            ("type", "0"),
            ("page", "1"),
            ("num", "1000"),
        ],
    )
    .await?;
    let list = data
        .get("result")
        .and_then(|r| r.get("data"))
        .and_then(|d| d.get("report_list"))
        .and_then(|v| v.as_object())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("新浪返回结构异常（缺少 result.data.report_list）"))?;
    Ok(list)
}

fn items_of(period: &Value) -> Vec<Value> {
    period
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// 财务关键指标 → 年度记录（最多 5 期）
pub async fn fetch_abstract(code: &str) -> Result<Vec<FinanceRecord>> {
    let list = fetch_report(code, "gjzb").await?;
    let mut periods: Vec<String> = list
        .keys()
        .filter(|k| k.ends_with("1231"))
        .cloned()
        .collect();
    periods.sort();
    periods.reverse();
    periods.truncate(5);

    let mut out = Vec::new();
    for period in periods {
        let items = items_of(&list[&period]);
        if items.is_empty() {
            continue;
        }
        let year = period[..4].to_string();

        let mut metrics = Map::new();
        for (key, title, unit) in FINANCE_METRICS {
            if let Some(v) = item_value(&items, title) {
                let value = match *unit {
                    "wan" => json!(((v / 1e4) * 100.0).round() / 100.0),
                    "ratio" => json!((v * 10000.0).round() / 10000.0),
                    _ => json!((v * 1e6).round() / 1e6),
                };
                metrics.insert((*key).to_string(), value);
            }
        }

        let revenue = item_value(&items, "营业总收入").unwrap_or(0.0);
        let net_profit = item_value(&items, "归母净利润").unwrap_or(0.0);
        let debt_ratio = item_value(&items, "资产负债率").unwrap_or(0.0);
        let equity = item_value(&items, "股东权益合计(净资产)");
        let (mut total_assets, mut total_liabilities) = (0.0f64, 0.0f64);
        if let Some(eq) = equity {
            if (0.0..100.0).contains(&debt_ratio) {
                let ta = eq / (1.0 - debt_ratio / 100.0);
                total_assets = ta;
                total_liabilities = ta - eq;
            }
        }

        out.push(FinanceRecord {
            year,
            report_type: "年报".into(),
            revenue: round2(revenue / 1e4),
            net_profit: round2(net_profit / 1e4),
            debt_ratio: round2(debt_ratio),
            total_assets: round2(total_assets / 1e4),
            total_liabilities: round2(total_liabilities / 1e4),
            source: "新浪财经/关键指标（公开财报）".into(),
            metrics,
        });
    }
    Ok(out)
}

/// 三表 → 年度记录（绝对值科目，供 Z/F/M 模型使用），最多 5 期
pub async fn fetch_statements(code: &str) -> Result<Vec<FinanceRecord>> {
    let balance = fetch_report(code, "fzb").await?;
    let income = fetch_report(code, "lrb").await?;
    let cashflow = fetch_report(code, "llb").await?;

    let mut periods: Vec<String> = balance
        .keys()
        .filter(|k| k.ends_with("1231"))
        .cloned()
        .collect();
    periods.sort();
    periods.reverse();
    periods.truncate(5);

    let mut out = Vec::new();
    for period in periods {
        let b = items_of(&balance[&period]);
        if b.is_empty() {
            continue;
        }
        let i = income.get(&period).map(items_of).unwrap_or_default();
        let c = cashflow.get(&period).map(items_of).unwrap_or_default();
        let year = period[..4].to_string();

        let mut metrics = Map::new();
        let mut collect = |items: &Vec<Value>, spec: &[(&str, &str)]| {
            for (key, title) in spec {
                if let Some(v) = item_value(items, title) {
                    let wan = (v / 1e4 * 100.0).round() / 100.0;
                    metrics.insert((*key).to_string(), json!(wan));
                }
            }
        };
        collect(&b, BALANCE_ITEMS);
        collect(&i, INCOME_ITEMS);
        collect(&c, CASHFLOW_ITEMS);

        let total_assets = item_value(&b, "资产总计").unwrap_or(0.0);
        let total_liabilities = item_value(&b, "负债合计").unwrap_or(0.0);
        let revenue = item_value(&i, "营业总收入").unwrap_or(0.0);
        let net_profit_parent = item_value(&i, "归属于母公司所有者的净利润")
            .or_else(|| item_value(&i, "净利润"))
            .unwrap_or(0.0);
        let equity = item_value(&b, "归属于母公司股东权益合计").unwrap_or(0.0);

        // 派生比率（供关键指标缺失时兜底）
        if revenue != 0.0 {
            if let Some(cost) = item_value(&i, "营业成本") {
                metrics
                    .entry("gross_margin".to_string())
                    .or_insert(json!((((1.0 - cost / revenue) * 100.0) * 10000.0).round() / 10000.0));
            }
            metrics
                .entry("net_margin".to_string())
                .or_insert(json!(((net_profit_parent / revenue * 100.0) * 10000.0).round() / 10000.0));
        }
        if equity != 0.0 {
            metrics
                .entry("roe".to_string())
                .or_insert(json!(((net_profit_parent / equity * 100.0) * 10000.0).round() / 10000.0));
        }
        if total_assets != 0.0 {
            metrics
                .entry("roa".to_string())
                .or_insert(json!(((net_profit_parent / total_assets * 100.0) * 10000.0).round() / 10000.0));
            if revenue != 0.0 {
                metrics
                    .entry("asset_turnover".to_string())
                    .or_insert(json!(((revenue / total_assets) * 1e6).round() / 1e6));
            }
        }
        let debt_ratio = if total_assets != 0.0 {
            ((total_liabilities / total_assets * 100.0) * 100.0).round() / 100.0
        } else {
            0.0
        };
        metrics.entry("debt_ratio".to_string()).or_insert(json!(debt_ratio));

        out.push(FinanceRecord {
            year,
            report_type: "年报".into(),
            revenue: round2(revenue / 1e4),
            net_profit: round2(net_profit_parent / 1e4),
            debt_ratio,
            total_assets: round2(total_assets / 1e4),
            total_liabilities: round2(total_liabilities / 1e4),
            source: "新浪财经/三表（公开财报）".into(),
            metrics,
        });
    }
    Ok(out)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// 供注册表使用的统一入口（返回 FetchResult，便于错误归档）
#[allow(dead_code)]
pub async fn fetch_finance(code: &str) -> FetchResult {
    let mut result = FetchResult {
        dimension: "finance".into(),
        source: "新浪财经".into(),
        ..Default::default()
    };
    match fetch_abstract(code).await {
        Ok(records) => result.finance.extend(records),
        Err(err) => result.error = Some(format!("关键指标失败：{err}")),
    }
    match fetch_statements(code).await {
        Ok(records) => result.finance.extend(records),
        Err(err) => {
            if result.error.is_none() {
                result.error = Some(format!("三表失败：{err}"));
            }
        }
    }
    result
}

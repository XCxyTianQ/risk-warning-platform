//! 金融分析引擎（与 Python 版 `app/services/finance.py` 逐条对齐）。
//!
//! 六块能力：概览 KPI、趋势序列、杜邦分解（含归因）、财务预警模型
//! （Altman Z / Z''、Piotroski F、Beneish M）、同业对标、异常勾稽；另含 Markdown 报告。
//!
//! 设计原则（与平台一致）：缺失即不参与（算不出的指标标注原因）、口径可追溯、
//! 模型逐项披露输入来源（exact / approx / missing）。

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::db::Db;

/// 指标元数据：(key, 标签, 单位, 分组, 是否越大越好)
pub const METRIC_META: &[(&str, &str, &str, &str, bool)] = &[
    ("revenue", "营业总收入", "万元", "scale", true),
    ("net_profit", "归母净利润", "万元", "scale", true),
    ("net_profit_total", "净利润（含少数股东）", "万元", "scale", true),
    ("gross_margin", "毛利率", "%", "profit", true),
    ("net_margin", "销售净利率", "%", "profit", true),
    ("roe", "净资产收益率 ROE", "%", "profit", true),
    ("roa", "总资产报酬率 ROA", "%", "profit", true),
    ("operating_margin", "营业利润率", "%", "profit", true),
    ("debt_ratio", "资产负债率", "%", "solvency", false),
    ("current_ratio", "流动比率", "倍", "solvency", true),
    ("quick_ratio", "速动比率", "倍", "solvency", true),
    ("equity_multiplier", "权益乘数", "倍", "solvency", false),
    ("asset_turnover", "总资产周转率", "次", "operation", true),
    ("ar_days", "应收账款周转天数", "天", "operation", false),
    ("inventory_days", "存货周转天数", "天", "operation", false),
    ("ocf", "经营活动现金流净额", "万元", "cashflow", true),
    ("ocf_to_profit", "现金含量（经营现金流/净利润）", "倍", "cashflow", true),
    ("ocf_to_revenue", "经营现金流/营业收入", "倍", "cashflow", true),
    ("revenue_growth", "营业总收入增速", "%", "growth", true),
    ("profit_growth", "归母净利润增速", "%", "growth", true),
    ("goodwill_ratio", "商誉/净资产", "%", "solvency", false),
    ("deducted_ratio", "扣非净利润/净利润", "倍", "profit", true),
    ("deducted_profit", "扣非净利润", "万元", "profit", true),
];

const DIM_LABELS: &[(&str, &str)] = &[
    ("scale", "规模"),
    ("profit", "盈利能力"),
    ("solvency", "偿债与杠杆"),
    ("operation", "营运效率"),
    ("cashflow", "现金流质量"),
    ("growth", "成长性"),
];

fn meta(key: &str) -> (&str, &'static str, &'static str, bool) {
    for (k, label, unit, group, higher) in METRIC_META {
        if *k == key {
            return (label, unit, group, *higher);
        }
    }
    (key, "", "", true)
}

fn round(v: f64, nd: i32) -> f64 {
    let factor = 10f64.powi(nd);
    (v * factor).round() / factor
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn div(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) if b != 0.0 => Some(a / b),
        _ => None,
    }
}

fn pct(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    div(a, b).map(|v| round(v * 100.0, 4))
}


fn g(m: &Map<String, Value>, key: &str) -> Option<f64> {
    num(m.get(key))
}

fn r4(v: Option<f64>) -> Value {
    match v {
        Some(v) => json!(round(v, 4)),
        None => Value::Null,
    }
}

fn r2(v: Option<f64>) -> Value {
    match v {
        Some(v) => json!(round(v, 2)),
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// 期间序列
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct Period {
    pub year: String,
    pub report_type: String,
    pub source: String,
    pub m: Map<String, Value>,
    pub derived: Vec<String>,
}

impl Period {
    fn f(&self, key: &str) -> Option<f64> {
        num(self.m.get(key))
    }
}

/// 读取期间序列（顶层字段兜底 + 统一口径派生）
pub fn load_periods(db: &Db, enterprise_id: i64, years: usize) -> Result<Vec<Period>> {
    let rows: Vec<(String, String, f64, f64, f64, f64, String, String)> = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT year, report_type, revenue, net_profit, total_assets, total_liabilities,
                    source, metrics_json
             FROM finance WHERE enterprise_id = ?1 AND year != '' ORDER BY year ASC",
        )?;
        let rows = stmt
            .query_map([enterprise_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, f64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let start = rows.len().saturating_sub(years);
    let mut periods: Vec<Period> = Vec::new();
    for (year, report_type, revenue, net_profit, total_assets, total_liabilities, source, metrics) in
        rows[start..].iter()
    {
        let mut m: Map<String, Value> = serde_json::from_str(metrics)
            .ok()
            .and_then(|v: Value| v.as_object().cloned())
            .unwrap_or_default();
        // 顶层字段兜底（老数据 / 样例数据）
        for (key, value) in [
            ("revenue_wan", *revenue),
            ("net_profit_wan", *net_profit),
            ("total_assets_wan", *total_assets),
            ("total_liabilities_wan", *total_liabilities),
        ] {
            if value != 0.0 && num(m.get(key)).is_none() {
                m.insert(key.to_string(), json!(value));
            }
        }
        let mut p = Period {
            year: year.clone(),
            report_type: if report_type.is_empty() { "年报".into() } else { report_type.clone() },
            source: source.clone(),
            m,
            derived: Vec::new(),
        };

        // 规范化字段名
        let aliases: [(&str, &str); 42] = [
            ("revenue", "revenue_wan"),
            ("net_profit", "net_profit_wan"),
            ("net_profit_total", "net_profit_total_wan"),
            ("total_assets", "total_assets_wan"),
            ("total_liabilities", "total_liabilities_wan"),
            ("equity", "equity_wan"),
            ("ocf", "ocf_wan"),
            ("gross_margin", "gross_margin"),
            ("net_margin", "net_margin"),
            ("roe", "roe"),
            ("roa", "roa"),
            ("operating_margin", "operating_margin"),
            ("current_ratio", "current_ratio"),
            ("quick_ratio", "quick_ratio"),
            ("equity_multiplier", "equity_multiplier"),
            ("asset_turnover", "asset_turnover"),
            ("ar_days", "ar_days"),
            ("inventory_days", "inventory_days"),
            ("revenue_growth", "revenue_growth"),
            ("profit_growth", "profit_growth"),
            ("ocf_to_revenue", "ocf_to_revenue"),
            ("ocf_to_profit", "ocf_to_profit"),
            ("current_assets", "current_assets_wan"),
            ("current_liabilities", "current_liabilities_wan"),
            ("accounts_receivable", "accounts_receivable_wan"),
            ("inventory", "inventory_wan"),
            ("goodwill", "goodwill_wan"),
            ("fixed_assets", "fixed_assets_wan"),
            ("fixed_assets_gross", "fixed_assets_gross_wan"),
            ("accum_depreciation", "accum_depreciation_wan"),
            ("surplus_reserve", "surplus_reserve_wan"),
            ("undistributed_profit", "undistributed_profit_wan"),
            ("operating_profit", "operating_profit_wan"),
            ("finance_expense", "finance_expense_wan"),
            ("selling_expense", "selling_expense_wan"),
            ("admin_expense", "admin_expense_wan"),
            ("rd_expense", "rd_expense_wan"),
            ("capex", "capex_wan"),
            ("deducted_profit", "deducted_profit_wan"),
            ("bvps", "bvps"),
            ("period_expense_ratio", "period_expense_ratio"),
            ("debt_ratio", "debt_ratio"),
        ];
        let mut flat: Map<String, Value> = Map::new();
        for (out_key, src_key) in aliases {
            if let Some(v) = p.m.get(src_key) {
                flat.insert(out_key.to_string(), v.clone());
            }
        }
        // 权益兜底
        if flat.get("equity").is_none() {
            if let (Some(ta), Some(tl)) = (num(flat.get("total_assets")), num(flat.get("total_liabilities"))) {
                flat.insert("equity".into(), json!(round(ta - tl, 2)));
            }
        }
        if flat.get("net_profit").is_none() {
            if let Some(v) = flat.get("net_profit_total") {
                flat.insert("net_profit".into(), v.clone());
            }
        }
        p.m = flat;

        // 派生（仅当原始指标缺失）
        let mut derived: Vec<String> = Vec::new();
        // 读值统一走自由函数，避免闭包长期借用 p.m
        if g(&p.m, "net_margin").is_none() && g(&p.m, "revenue").is_some() && g(&p.m, "net_profit").is_some() {
            let v = pct(g(&p.m, "net_profit"), g(&p.m, "revenue"));
            p.m.insert("net_margin".into(), r4(v));
            derived.push("net_margin".into());
        }
        if g(&p.m, "gross_margin").is_none() && g(&p.m, "revenue").is_some() && g(&p.m, "operating_cost").is_none() {
            if let Some(cost) = g(&p.m, "operating_cost_wan") {
                let v = pct(Some(g(&p.m, "revenue").unwrap() - cost), g(&p.m, "revenue"));
                p.m.insert("gross_margin".into(), r4(v));
                derived.push("gross_margin".into());
            }
        }
        if g(&p.m, "roe").is_none() && g(&p.m, "net_profit").is_some() && g(&p.m, "equity").is_some() {
            let v = pct(g(&p.m, "net_profit"), g(&p.m, "equity"));
            p.m.insert("roe".into(), r4(v));
            derived.push("roe".into());
        }
        if g(&p.m, "roa").is_none() && g(&p.m, "net_profit").is_some() && g(&p.m, "total_assets").is_some() {
            let v = pct(g(&p.m, "net_profit"), g(&p.m, "total_assets"));
            p.m.insert("roa".into(), r4(v));
            derived.push("roa".into());
        }
        if g(&p.m, "equity_multiplier").is_none() && g(&p.m, "total_assets").is_some() && g(&p.m, "equity").is_some() {
            let v = div(g(&p.m, "total_assets"), g(&p.m, "equity"));
            p.m.insert("equity_multiplier".into(), r4(v));
            derived.push("equity_multiplier".into());
        }
        if g(&p.m, "current_ratio").is_none() && g(&p.m, "current_assets").is_some() && g(&p.m, "current_liabilities").is_some() {
            let v = div(g(&p.m, "current_assets"), g(&p.m, "current_liabilities"));
            p.m.insert("current_ratio".into(), r4(v));
            derived.push("current_ratio".into());
        }
        if g(&p.m, "asset_turnover").is_none() && g(&p.m, "revenue").is_some() && g(&p.m, "total_assets").is_some() {
            let v = div(g(&p.m, "revenue"), g(&p.m, "total_assets"));
            p.m.insert("asset_turnover".into(), r4(v));
            derived.push("asset_turnover".into());
        }
        if g(&p.m, "ocf_to_profit").is_none() && g(&p.m, "ocf").is_some() && g(&p.m, "net_profit").is_some() {
            let v = div(g(&p.m, "ocf"), g(&p.m, "net_profit"));
            p.m.insert("ocf_to_profit".into(), r4(v));
            derived.push("ocf_to_profit".into());
        }
        if g(&p.m, "goodwill").is_some() && g(&p.m, "equity").is_some() && g(&p.m, "goodwill_ratio").is_none() {
            let v = pct(g(&p.m, "goodwill"), g(&p.m, "equity"));
            p.m.insert("goodwill_ratio".into(), r4(v));
        }
        if g(&p.m, "deducted_profit").is_some() && g(&p.m, "net_profit").is_some() && g(&p.m, "deducted_ratio").is_none() {
            let v = div(g(&p.m, "deducted_profit"), g(&p.m, "net_profit"));
            p.m.insert("deducted_ratio".into(), r4(v));
        }
        if g(&p.m, "equity").is_some() && g(&p.m, "bvps").is_some() && g(&p.m, "shares_wan").is_none() {
            let v = div(g(&p.m, "equity"), g(&p.m, "bvps"));
            p.m.insert("shares_wan".into(), r4(v));
        }
        p.derived = derived;
        periods.push(p);
    }

    // 同比：源指标缺失时按上期计算
    for i in 1..periods.len() {
        let (prev, cur) = (periods[i - 1].clone(), periods[i].clone());
        let mut cur = cur;
        let _ = &prev;
        if num(cur.m.get("revenue_growth")).is_none() {
            if let (Some(c), Some(p0)) = (num(cur.m.get("revenue")), num(prev.m.get("revenue"))) {
                if p0 != 0.0 {
                    cur.m.insert("revenue_growth".into(), r4(pct(Some(c - p0), Some(p0.abs()))));
                }
            }
        }
        if num(cur.m.get("profit_growth")).is_none() {
            if let (Some(c), Some(p0)) = (num(cur.m.get("net_profit")), num(prev.m.get("net_profit"))) {
                if p0 != 0.0 {
                    cur.m.insert("profit_growth".into(), r4(pct(Some(c - p0), Some(p0.abs()))));
                }
            }
        }
        periods[i] = cur;
    }
    Ok(periods)
}

// ---------------------------------------------------------------------------
// 1. 概览 KPI
// ---------------------------------------------------------------------------

pub const KPI_KEYS: &[&str] = &[
    "revenue", "net_profit", "deducted_profit", "gross_margin", "net_margin", "roe", "roa",
    "debt_ratio", "ocf", "ocf_to_profit", "revenue_growth", "profit_growth",
    "current_ratio", "ar_days", "inventory_days", "goodwill_ratio",
];

pub fn build_kpi(periods: &[Period]) -> Value {
    let cur = periods.last();
    let prev = if periods.len() >= 2 { Some(&periods[periods.len() - 2]) } else { None };
    let mut out = Vec::new();
    for key in KPI_KEYS {
        let (label, unit, group, higher_better) = meta(key);
        let v = cur.and_then(|p| p.f(key));
        let pv = prev.and_then(|p| p.f(key));
        let yoy = match (v, pv) {
            (Some(v), Some(pv)) if pv != 0.0 => Some(round((v - pv) / pv.abs() * 100.0, 2)),
            _ => None,
        };
        let trend = match (v, pv) {
            (Some(v), Some(pv)) => {
                if (v - pv).abs() < 1e-9 {
                    "flat"
                } else if (v > pv) == higher_better {
                    "up"
                } else {
                    "down"
                }
            }
            _ => "flat",
        };
        out.push(json!({
            "key": key,
            "label": label,
            "unit": unit,
            "group": group,
            "value": r2(v),
            "prev": r2(pv),
            "yoy": yoy,
            "trend": trend,
            "higher_better": higher_better,
            "available": v.is_some(),
            "year": cur.map(|p| p.year.clone()),
            "note": if v.is_some() { "" } else { "该期无此指标（数据源未提供或未采集）" },
        }));
    }
    Value::Array(out)
}

// ---------------------------------------------------------------------------
// 2. 趋势序列
// ---------------------------------------------------------------------------

pub fn build_trends(periods: &[Period]) -> Value {
    let mut groups: BTreeMap<String, Value> = BTreeMap::new();
    for (key, label, unit, group, _higher) in METRIC_META {
        if ["net_profit_total", "goodwill_ratio", "deducted_ratio", "deducted_profit"]
            .contains(key)
        {
            continue;
        }
        let points: Vec<Value> = periods
            .iter()
            .map(|p| json!({ "year": p.year, "value": r2(p.f(key)) }))
            .collect();
        let has_value = points.iter().any(|pt| !pt["value"].is_null());
        if !has_value {
            continue;
        }
        let group_label = DIM_LABELS
            .iter()
            .find(|(k, _)| k == group)
            .map(|(_, v)| *v)
            .unwrap_or(group);
        let entry = groups
            .entry((*group).to_string())
            .or_insert_with(|| json!({ "label": group_label, "series": [] }));
        entry["series"]
            .as_array_mut()
            .expect("series array")
            .push(json!({ "key": key, "label": label, "unit": unit, "points": points }));
    }
    Value::Object(groups.into_iter().collect())
}

// ---------------------------------------------------------------------------
// 3. 杜邦分解
// ---------------------------------------------------------------------------

pub fn build_dupont(periods: &[Period]) -> Value {
    let mut rows: Vec<Value> = Vec::new();
    for p in periods {
        let margin = div(p.f("net_profit"), p.f("revenue"));
        let turnover = div(p.f("revenue"), p.f("total_assets"));
        let leverage = div(p.f("total_assets"), p.f("equity"));
        let roe = match (margin, turnover, leverage) {
            (Some(m), Some(t), Some(l)) => Some(m * t * l),
            _ => None,
        };
        rows.push(json!({
            "year": p.year,
            "roe": r2(roe.map(|v| v * 100.0).or(p.f("roe"))),
            "net_margin": r2(margin.map(|v| v * 100.0).or(p.f("net_margin"))),
            "asset_turnover": r4(turnover),
            "equity_multiplier": r4(leverage),
            "complete": roe.is_some(),
        }));
    }

    let mut attribution: Value = Value::Null;
    if rows.len() >= 2 {
        let a = &rows[rows.len() - 2];
        let b = &rows[rows.len() - 1];
        if a["complete"].as_bool() == Some(true) && b["complete"].as_bool() == Some(true) {
            let (m0, t0, l0) = (
                a["net_margin"].as_f64().unwrap_or(0.0) / 100.0,
                a["asset_turnover"].as_f64().unwrap_or(0.0),
                a["equity_multiplier"].as_f64().unwrap_or(0.0),
            );
            let (m1, t1, l1) = (
                b["net_margin"].as_f64().unwrap_or(0.0) / 100.0,
                b["asset_turnover"].as_f64().unwrap_or(0.0),
                b["equity_multiplier"].as_f64().unwrap_or(0.0),
            );
            attribution = json!({
                "from_year": a["year"],
                "to_year": b["year"],
                "roe_delta": round(b["roe"].as_f64().unwrap_or(0.0) - a["roe"].as_f64().unwrap_or(0.0), 2),
                "items": [
                    { "key": "net_margin", "label": "销售净利率", "contrib": round((m1 - m0) * t0 * l0 * 100.0, 2) },
                    { "key": "asset_turnover", "label": "总资产周转率", "contrib": round(m1 * (t1 - t0) * l0 * 100.0, 2) },
                    { "key": "equity_multiplier", "label": "权益乘数（杠杆）", "contrib": round(m1 * t1 * (l1 - l0) * 100.0, 2) },
                ],
                "note": "按三因素顺序分解，贡献之和 = ROE 变动（单位：百分点）",
            });
        }
    }

    json!({
        "formula": "ROE = 销售净利率 × 总资产周转率 × 权益乘数",
        "rows": rows,
        "attribution": attribution,
    })
}

// ---------------------------------------------------------------------------
// 4. 财务预警模型
// ---------------------------------------------------------------------------

fn component(value: Option<f64>, source: &str, label: &str) -> Value {
    json!({ "value": r4(value), "source": source, "label": label })
}

fn z_verdict(score: Option<f64>, safe: f64, distress: f64) -> Value {
    match score {
        None => Value::Null,
        Some(s) if s > safe => json!("安全区"),
        Some(s) if s >= distress => json!("灰色区"),
        Some(_) => json!("困境区"),
    }
}

pub fn build_altman(p: &Period, market_cap_wan: Option<f64>) -> Value {
    let ca = p.f("current_assets");
    let cl = p.f("current_liabilities");
    let ta = p.f("total_assets");
    let tl = p.f("total_liabilities");
    let eq = p.f("equity");
    let rev = p.f("revenue");
    let retained = match (p.f("surplus_reserve"), p.f("undistributed_profit")) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    };
    let ebit = p.f("operating_profit").map(|op| op + p.f("finance_expense").unwrap_or(0.0));

    let x1 = div(if ca.is_some() && cl.is_some() { Some(ca.unwrap() - cl.unwrap()) } else { None }, ta);
    let x2 = div(retained, ta);
    let x3 = div(ebit, ta);
    let x5 = div(rev, ta);

    let mut comps: Map<String, Value> = Map::new();
    comps.insert(
        "X1".into(),
        component(x1, if ca.is_some() && cl.is_some() && ta.is_some() { "exact" } else { "missing" }, "营运资金 / 总资产"),
    );
    comps.insert("X2".into(), component(x2, if retained.is_some() && ta.is_some() { "exact" } else { "missing" }, "留存收益 / 总资产"));
    comps.insert("X3".into(), component(x3, if ebit.is_some() && ta.is_some() { "exact" } else { "missing" }, "EBIT / 总资产"));
    comps.insert("X5".into(), component(x5, if rev.is_some() && ta.is_some() { "exact" } else { "missing" }, "营业收入 / 总资产"));

    // Z''（账面权益口径）
    let mut z2_comps = comps.clone();
    z2_comps.insert("X4".into(), component(div(eq, tl), if eq.is_some() && tl.is_some() { "exact" } else { "missing" }, "账面净资产 / 总负债"));
    let z2_missing: Vec<String> = z2_comps
        .iter()
        .filter(|(_, v)| v["source"] == "missing")
        .map(|(k, _)| k.clone())
        .collect();
    let z2 = if z2_missing.is_empty() {
        Some(
            6.56 * z2_comps["X1"]["value"].as_f64().unwrap_or(0.0)
                + 3.26 * z2_comps["X2"]["value"].as_f64().unwrap_or(0.0)
                + 6.72 * z2_comps["X3"]["value"].as_f64().unwrap_or(0.0)
                + 1.05 * z2_comps["X4"]["value"].as_f64().unwrap_or(0.0),
        )
    } else {
        None
    };

    // Z（市值口径）
    let mut z_comps = comps.clone();
    z_comps.insert(
        "X4".into(),
        match market_cap_wan {
            Some(cap) => component(div(Some(cap), tl), if tl.is_some() { "exact" } else { "missing" }, "股权市值 / 总负债"),
            None => component(None, "missing", "股权市值 / 总负债（未取到总市值）"),
        },
    );
    let z_missing: Vec<String> = z_comps
        .iter()
        .filter(|(_, v)| v["source"] == "missing")
        .map(|(k, _)| k.clone())
        .collect();
    let z = if z_missing.is_empty() {
        Some(
            1.2 * z_comps["X1"]["value"].as_f64().unwrap_or(0.0)
                + 1.4 * z_comps["X2"]["value"].as_f64().unwrap_or(0.0)
                + 3.3 * z_comps["X3"]["value"].as_f64().unwrap_or(0.0)
                + 0.6 * z_comps["X4"]["value"].as_f64().unwrap_or(0.0)
                + 1.0 * z_comps["X5"]["value"].as_f64().unwrap_or(0.0),
        )
    } else {
        None
    };

    let missing_labels = |comps: &Map<String, Value>, keys: &[String]| -> Vec<Value> {
        keys.iter()
            .map(|k| json!(format!("{}（{}）", k, comps.get(k).and_then(|v| v["label"].as_str()).unwrap_or(""))))
            .collect()
    };
    let z2_missing_labels = missing_labels(&z2_comps, &z2_missing);
    let z_missing_labels = missing_labels(&z_comps, &z_missing);

    json!({
        "key": "altman",
        "name": "Altman Z-Score 财务困境预警",
        "period": p.year,
        "z": {
            "score": r4(z.map(|v| round(v, 3))),
            "verdict": z_verdict(z, 2.99, 1.81),
            "available": z.is_some(),
            "basis": "股权市值 / 总负债（上市制造业口径）",
            "thresholds": "Z > 2.99 安全 · 1.81 ~ 2.99 灰色 · Z < 1.81 困境",
            "components": Value::Object(z_comps),
            "missing": z_missing_labels,
            "note": if z.is_some() { "" } else { "缺少市值或绝对值科目，无法计算 Z；可参考 Z''-Score" },
        },
        "z2": {
            "score": r4(z2.map(|v| round(v, 3))),
            "verdict": z_verdict(z2, 2.6, 1.1),
            "available": z2.is_some(),
            "basis": "账面净资产 / 总负债（非制造业 / 新兴市场口径）",
            "thresholds": "Z'' > 2.6 安全 · 1.1 ~ 2.6 灰色 · Z'' < 1.1 困境",
            "components": Value::Object(z2_comps),
            "missing": z2_missing_labels,
            "note": if z2.is_some() { "" } else { "缺少绝对值科目，无法计算 Z''" },
        },
    })
}

pub fn build_piotroski(periods: &[Period]) -> Value {
    if periods.len() < 2 {
        return json!({
            "key": "piotroski", "name": "Piotroski F-Score", "available": false,
            "reason": "需要连续两年财报", "signals": [], "score": Value::Null, "max_score": 0,
        });
    }
    let cur = &periods[periods.len() - 1];
    let prev = &periods[periods.len() - 2];

    let roa = |p: &Period| div(p.f("net_profit"), p.f("total_assets"));
    let cfo_ta = |p: &Period| div(p.f("ocf"), p.f("total_assets"));

    let mut signals: Vec<Value> = Vec::new();
    let add = |name: &str, ok: Option<bool>, detail: String, group: &str, signals: &mut Vec<Value>| {
        signals.push(json!({
            "name": name,
            "group": group,
            "pass": ok,
            "detail": detail,
        }));
    };

    let (r_cur, r_prev) = (roa(cur), roa(prev));
    add(
        "ROA 为正",
        r_cur.map(|v| v > 0.0),
        match r_cur {
            Some(v) => format!("ROA = {}%", round(v * 100.0, 2)),
            None => "缺净利润/总资产".into(),
        },
        "盈利",
        &mut signals,
    );
    add(
        "经营现金流为正",
        cur.f("ocf").map(|v| v > 0.0),
        match cur.f("ocf") {
            Some(v) => format!("经营现金流 = {} 万元", round(v, 0)),
            None => "缺经营现金流".into(),
        },
        "盈利",
        &mut signals,
    );
    add(
        "ROA 同比改善",
        match (r_cur, r_prev) {
            (Some(a), Some(b)) => Some(a > b),
            _ => None,
        },
        match (r_cur, r_prev) {
            (Some(a), Some(b)) => format!("{}% → {}%", round(b * 100.0, 2), round(a * 100.0, 2)),
            _ => "缺两年 ROA".into(),
        },
        "盈利",
        &mut signals,
    );
    let c_cur = cfo_ta(cur);
    add(
        "经营现金流优于 ROA（应计质量）",
        match (c_cur, r_cur) {
            (Some(c), Some(r)) => Some(c > r),
            _ => None,
        },
        match (c_cur, r_cur) {
            (Some(c), Some(r)) => format!("CFO/TA = {}% vs ROA = {}%", round(c * 100.0, 2), round(r * 100.0, 2)),
            _ => "缺经营现金流/总资产".into(),
        },
        "盈利",
        &mut signals,
    );

    let (d_cur, d_prev) = (cur.f("debt_ratio"), prev.f("debt_ratio"));
    add(
        "杠杆率下降",
        match (d_cur, d_prev) {
            (Some(a), Some(b)) => Some(a < b),
            _ => None,
        },
        match (d_cur, d_prev) {
            (Some(a), Some(b)) => format!("资产负债率 {b}% → {a}%"),
            _ => "缺资产负债率".into(),
        },
        "偿债",
        &mut signals,
    );
    let (cr_cur, cr_prev) = (cur.f("current_ratio"), prev.f("current_ratio"));
    add(
        "流动比率上升",
        match (cr_cur, cr_prev) {
            (Some(a), Some(b)) => Some(a > b),
            _ => None,
        },
        match (cr_cur, cr_prev) {
            (Some(a), Some(b)) => format!("流动比率 {b} → {a}"),
            _ => "缺流动比率".into(),
        },
        "偿债",
        &mut signals,
    );
    let (s_cur, s_prev) = (cur.f("shares_wan"), prev.f("shares_wan"));
    add(
        "未增发股本",
        match (s_cur, s_prev) {
            (Some(a), Some(b)) => Some(a <= b * 1.01),
            _ => None,
        },
        match (s_cur, s_prev) {
            (Some(a), Some(b)) => format!("股本 {} → {} 万股", round(b, 0), round(a, 0)),
            _ => "缺每股净资产/净资产，无法推算股本".into(),
        },
        "偿债",
        &mut signals,
    );
    let (g_cur, g_prev) = (cur.f("gross_margin"), prev.f("gross_margin"));
    add(
        "毛利率上升",
        match (g_cur, g_prev) {
            (Some(a), Some(b)) => Some(a > b),
            _ => None,
        },
        match (g_cur, g_prev) {
            (Some(a), Some(b)) => format!("毛利率 {b}% → {a}%"),
            _ => "缺毛利率".into(),
        },
        "效率",
        &mut signals,
    );
    let (t_cur, t_prev) = (cur.f("asset_turnover"), prev.f("asset_turnover"));
    add(
        "总资产周转率上升",
        match (t_cur, t_prev) {
            (Some(a), Some(b)) => Some(a > b),
            _ => None,
        },
        match (t_cur, t_prev) {
            (Some(a), Some(b)) => format!("周转率 {b} → {a}"),
            _ => "缺总资产周转率".into(),
        },
        "效率",
        &mut signals,
    );

    let scored: Vec<&Value> = signals.iter().filter(|s| !s["pass"].is_null()).collect();
    let score = if scored.is_empty() {
        None
    } else {
        Some(scored.iter().filter(|s| s["pass"] == json!(true)).count())
    };
    let max_score = scored.len();
    let verdict = if max_score == 9 {
        match score {
            Some(s) if s >= 7 => Some("基本面强（≥7）"),
            Some(s) if s >= 4 => Some("基本面中等（4~6）"),
            _ => Some("基本面弱（≤3）"),
        }
    } else {
        None
    };
    let mut note = if max_score == 9 {
        String::new()
    } else {
        format!("9 项中 {} 项因数据缺失未评分，得分为可评分项之和", 9 - max_score)
    };
    if let Some(r) = r_cur {
        if r < 0.02 {
            if !note.is_empty() {
                note.push_str("；");
            }
            note.push_str(&format!(
                "注意：F-Score 衡量同比改善方向，当前 ROA 仅 {}%，绝对盈利水平仍很低",
                round(r * 100.0, 2)
            ));
        }
    }

    json!({
        "key": "piotroski",
        "name": "Piotroski F-Score",
        "period": cur.year,
        "available": score.is_some(),
        "score": score,
        "max_score": max_score,
        "full_score": 9,
        "verdict": verdict,
        "complete": max_score == 9,
        "signals": signals,
        "note": note,
    })
}

pub fn build_beneish(periods: &[Period]) -> Value {
    if periods.len() < 2 {
        return json!({
            "key": "beneish", "name": "Beneish M-Score", "available": false,
            "reason": "需要连续两年财报", "indices": [], "score": Value::Null,
        });
    }
    let cur = &periods[periods.len() - 1];
    let prev = &periods[periods.len() - 2];
    let mut indices: Vec<Value> = Vec::new();
    let push = |key: &str, label: &str, value: Option<f64>, source: &str, detail: String, indices: &mut Vec<Value>| {
        indices.push(json!({
            "key": key, "label": label, "value": r4(value), "source": source, "detail": detail,
        }));
    };

    // DSRI
    let _dsri = match (
        cur.f("accounts_receivable"), cur.f("revenue"),
        prev.f("accounts_receivable"), prev.f("revenue"),
    ) {
        (Some(ar1), Some(rev1), Some(ar0), Some(rev0)) => {
            let a = div(Some(ar1), Some(rev1));
            let b = div(Some(ar0), Some(rev0));
            let v = div(a, b);
            push("DSRI", "应收账款指数", v, "exact", "应收账款/营业收入 的同比变化".into(), &mut indices);
            v
        }
        _ => {
            push("DSRI", "应收账款指数", None, "missing", "缺应收账款或营业收入".into(), &mut indices);
            None
        }
    };

    // GMI
    let (gm1, gm0) = (cur.f("gross_margin"), prev.f("gross_margin"));
    let _gmi = match (gm1, gm0) {
        (Some(a), Some(b)) if a != 0.0 && b != 0.0 => {
            let v = Some(b / a);
            push("GMI", "毛利率指数", v, "exact", format!("毛利率 {b}% → {a}%"), &mut indices);
            v
        }
        _ => {
            push("GMI", "毛利率指数", None, "missing", "缺毛利率".into(), &mut indices);
            None
        }
    };

    // AQI
    let _aqi = match (
        cur.f("current_assets"), cur.f("fixed_assets"), cur.f("total_assets"),
        prev.f("current_assets"), prev.f("fixed_assets"), prev.f("total_assets"),
    ) {
        (Some(ca1), Some(fa1), Some(ta1), Some(ca0), Some(fa0), Some(ta0))
            if ta1 != 0.0 && ta0 != 0.0 =>
        {
            let r1 = 1.0 - (ca1 + fa1) / ta1;
            let r0 = 1.0 - (ca0 + fa0) / ta0;
            let v = div(Some(r1), Some(r0));
            push("AQI", "资产质量指数", v, "exact", "非流动硬资产占比的同比变化".into(), &mut indices);
            v
        }
        _ => {
            push("AQI", "资产质量指数", None, "missing", "缺流动资产/固定资产/总资产".into(), &mut indices);
            None
        }
    };

    // SGI
    let _sgi = match (cur.f("revenue"), prev.f("revenue")) {
        (Some(a), Some(b)) if b != 0.0 => {
            let v = Some(a / b);
            push("SGI", "销售增长指数", v, "exact", format!("营业收入 {b} → {a} 万元"), &mut indices);
            v
        }
        _ => {
            push("SGI", "销售增长指数", None, "missing", "缺营业收入".into(), &mut indices);
            None
        }
    };

    // DEPI（用累计折旧增额近似当期折旧）
    let _depi = match (
        cur.f("accum_depreciation"), prev.f("accum_depreciation"),
        cur.f("fixed_assets_gross"), prev.f("fixed_assets_gross"),
    ) {
        (Some(acc1), Some(acc0), Some(gross1), Some(gross0)) if gross1 != 0.0 && gross0 != 0.0 => {
            let dep1 = (acc1 - acc0).max(0.0);
            let dep0 = acc0.max(0.0) * 0.1;
            let rate1 = div(Some(dep1), Some(dep1 + gross1));
            let rate0 = div(Some(dep0), Some(dep0 + gross0));
            let v = div(rate0, rate1);
            push("DEPI", "折旧率指数", v, "approx", "当期折旧用累计折旧增额近似，上期折旧按累计折旧 10% 近似".into(), &mut indices);
            v
        }
        _ => {
            push("DEPI", "折旧率指数", None, "missing", "缺累计折旧/固定资产原值".into(), &mut indices);
            None
        }
    };

    // SGAI
    let sga1 = match (cur.f("selling_expense"), cur.f("admin_expense")) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    };
    let sga0 = match (prev.f("selling_expense"), prev.f("admin_expense")) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    };
    let _sgai = match (sga1, sga0, cur.f("revenue"), prev.f("revenue")) {
        (Some(s1), Some(s0), Some(r1), Some(r0)) if r1 != 0.0 && r0 != 0.0 && s0 != 0.0 => {
            let v = div(Some(s1 / r1), Some(s0 / r0));
            push("SGAI", "销售管理费用指数", v, "exact", "（销售+管理）费用率的同比变化".into(), &mut indices);
            v
        }
        _ => {
            push("SGAI", "销售管理费用指数", None, "missing", "缺销售/管理费用".into(), &mut indices);
            None
        }
    };

    // LVGI
    let lv1 = div(cur.f("total_liabilities"), cur.f("total_assets"));
    let lv0 = div(prev.f("total_liabilities"), prev.f("total_assets"));
    let _lvgi = match (lv1, lv0) {
        (Some(a), Some(b)) if b != 0.0 => {
            let v = Some(a / b);
            push("LVGI", "杠杆指数", v, "exact", "资产负债率的同比变化".into(), &mut indices);
            v
        }
        _ => {
            push("LVGI", "杠杆指数", None, "missing", "缺总负债/总资产".into(), &mut indices);
            None
        }
    };

    // TATA
    let _tata = match (cur.f("net_profit"), cur.f("ocf"), cur.f("total_assets")) {
        (Some(np_), Some(ocf), Some(ta)) if ta != 0.0 => {
            let v = Some((np_ - ocf) / ta);
            push("TATA", "总应计项目", v, "exact", "（净利润 − 经营现金流）/ 总资产".into(), &mut indices);
            v
        }
        _ => {
            push("TATA", "总应计项目", None, "missing", "缺净利润/经营现金流/总资产".into(), &mut indices);
            None
        }
    };

    let get = |key: &str| -> Option<f64> {
        indices
            .iter()
            .find(|i| i["key"] == key)
            .and_then(|i| i["value"].as_f64())
    };
    let missing: Vec<String> = indices
        .iter()
        .filter(|i| i["value"].is_null())
        .map(|i| i["label"].as_str().unwrap_or("").to_string())
        .collect();
    let score = if missing.is_empty() {
        Some(
            -4.84
                + 0.920 * get("DSRI").unwrap_or(0.0)
                + 0.528 * get("GMI").unwrap_or(0.0)
                + 0.404 * get("AQI").unwrap_or(0.0)
                + 0.892 * get("SGI").unwrap_or(0.0)
                + 0.115 * get("DEPI").unwrap_or(0.0)
                - 0.172 * get("SGAI").unwrap_or(0.0)
                + 4.679 * get("TATA").unwrap_or(0.0)
                - 0.327 * get("LVGI").unwrap_or(0.0),
        )
    } else {
        None
    };
    let verdict = score.map(|s| if s > -1.78 { "存在盈余操纵嫌疑" } else { "未见明显操纵迹象" });
    let approx: Vec<String> = indices
        .iter()
        .filter(|i| i["source"] == "approx")
        .map(|i| i["label"].as_str().unwrap_or("").to_string())
        .collect();

    json!({
        "key": "beneish",
        "name": "Beneish M-Score 盈余操纵识别",
        "period": cur.year,
        "available": score.is_some(),
        "score": r4(score.map(|v| round(v, 3))),
        "thresholds": "M > -1.78 提示盈余操纵嫌疑（Beneish 1999 阈值）",
        "verdict": verdict,
        "indices": indices,
        "missing": missing,
        "approx": approx,
        "note": if approx.is_empty() {
            String::new()
        } else {
            format!("含近似项：{}；结论请结合审计意见判断", approx.join("、"))
        },
    })
}

// ---------------------------------------------------------------------------
// 5. 同业对标 / 6. 异常勾稽
// ---------------------------------------------------------------------------

pub const PEER_METRICS: &[&str] = &[
    "revenue", "revenue_growth", "gross_margin", "net_margin", "roe",
    "debt_ratio", "asset_turnover", "current_ratio", "ocf_to_profit",
];

fn percentile(values: &[f64], v: f64, higher_better: bool) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let below = values.iter().filter(|x| **x < v).count() as f64;
    let equal = values.iter().filter(|x| **x == v).count() as f64;
    let pct = (below + 0.5 * equal) / values.len() as f64 * 100.0;
    round(if higher_better { pct } else { 100.0 - pct }, 1)
}

pub fn build_peers(db: &Db, enterprise_id: i64, industry: &str, years: usize, limit: usize) -> Result<Value> {
    let all: Vec<(i64, String, String)> = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT id, name, industry FROM enterprise ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let same: Vec<(i64, String, String)> = all
        .iter()
        .filter(|(id, _, ind)| *id != enterprise_id && !industry.is_empty() && ind == industry)
        .take(limit)
        .cloned()
        .collect();
    let mut peers = same.clone();
    if peers.len() < 2 {
        for row in all.iter().filter(|(id, _, _)| *id != enterprise_id) {
            if !peers.iter().any(|(pid, _, _)| *pid == row.0) {
                peers.push(row.clone());
            }
            if peers.len() >= limit {
                break;
            }
        }
    }

    let mut rows: Vec<Value> = Vec::new();
    let self_ent = all.iter().find(|(id, _, _)| *id == enterprise_id).cloned();
    let mut entries: Vec<(i64, String, String, bool)> = Vec::new();
    if let Some((id, name, ind)) = self_ent {
        entries.push((id, name, ind, true));
    }
    for (id, name, ind) in peers {
        entries.push((id, name, ind, false));
    }

    for (id, name, ind, is_self) in &entries {
        let periods = load_periods(db, *id, years)?;
        let Some(cur) = periods.last() else { continue };
        let metrics: Map<String, Value> = PEER_METRICS
            .iter()
            .map(|k| ((*k).to_string(), r2(cur.f(k))))
            .collect();
        rows.push(json!({
            "enterprise_id": id,
            "name": name,
            "industry": ind,
            "is_self": is_self,
            "year": cur.year,
            "metrics": Value::Object(metrics),
        }));
    }

    for key in PEER_METRICS {
        let (_label, _unit, _group, higher_better) = meta(key);
        let values: Vec<f64> = rows
            .iter()
            .filter_map(|r| r["metrics"][key].as_f64())
            .collect();
        for row in rows.iter_mut() {
            let v = row["metrics"][key].as_f64();
            let p = v.map(|v| percentile(&values, v, higher_better));
            if let Some(obj) = row.as_object_mut() {
                let percentiles = obj
                    .entry("percentiles")
                    .or_insert_with(|| json!({}));
                if let Some(map) = percentiles.as_object_mut() {
                    map.insert((*key).to_string(), p.map(|x| json!(x)).unwrap_or(Value::Null));
                }
            }
        }
    }

    let self_row = rows.iter().find(|r| r["is_self"] == json!(true)).cloned();
    Ok(json!({
        "industry": industry,
        "rows": rows,
        "self": self_row,
        "metrics": PEER_METRICS
            .iter()
            .map(|k| {
                let (label, unit, _g, higher) = meta(k);
                json!({ "key": k, "label": label, "unit": unit, "higher_better": higher })
            })
            .collect::<Vec<_>>(),
        "note": if same.len() < 2 {
            "分位数按可比企业集合计算（含本企业）；同行业企业不足 2 家，已补充其他企业"
        } else {
            "分位数按可比企业集合计算（含本企业）"
        },
    }))
}

pub fn build_anomalies(periods: &[Period], peer_median: &Map<String, Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let Some(cur) = periods.last() else { return out };
    let prev = if periods.len() >= 2 { Some(&periods[periods.len() - 2]) } else { None };

    let add = |code: &str, level: &str, title: &str, detail: String, evidence: Value, out: &mut Vec<Value>| {
        out.push(json!({
            "code": code, "level": level, "title": title, "detail": detail, "evidence": evidence,
        }));
    };

    if let (Some(np_), Some(ocf)) = (cur.f("net_profit"), cur.f("ocf")) {
        if np_ > 0.0 && ocf < 0.0 {
            add(
                "OCF_NEGATIVE", "high", "净利润为正但经营现金流为负",
                format!("{} 年归母净利润 {} 万元，经营活动现金流 {} 万元，利润未转化为现金。", cur.year, round(np_, 0), round(ocf, 0)),
                json!({ "year": cur.year, "net_profit": np_, "ocf": ocf }), &mut out,
            );
        }
    }

    if let Some(ocfp) = cur.f("ocf_to_profit") {
        if (0.0..0.5).contains(&ocfp) && cur.f("net_profit").unwrap_or(0.0) > 0.0 {
            add(
                "LOW_CASH_CONTENT", "medium", "现金含量偏低",
                format!("经营现金流/净利润 = {ocfp}（低于 0.5），盈利质量偏弱。"),
                json!({ "year": cur.year, "ocf_to_profit": ocfp }), &mut out,
            );
        }
    }

    if let Some(prev) = prev {
        if let (Some(ar1), Some(ar0), Some(rev1), Some(rev0)) = (
            cur.f("accounts_receivable"), prev.f("accounts_receivable"),
            cur.f("revenue"), prev.f("revenue"),
        ) {
            let rev_g = pct(Some(rev1 - rev0), Some(rev0.abs()));
            let ar_g = pct(Some(ar1 - ar0), Some(ar0.abs()));
            if let (Some(rg), Some(ag)) = (rev_g, ar_g) {
                if rg > 20.0 && ag > rg + 20.0 {
                    add(
                        "AR_DIVERGENCE", "high", "应收账款增速显著高于营收",
                        format!("营收同比 {}%，应收账款同比 {}%，收入含金量需核实（是否存在放宽信用或提前确认收入）。", round(rg, 1), round(ag, 1)),
                        json!({ "year": cur.year, "revenue_growth": rg, "ar_growth": ag }), &mut out,
                    );
                }
            }
        }
    }

    if let (Some(gm), Some(median)) = (cur.f("gross_margin"), peer_median.get("gross_margin").and_then(|v| v.as_f64())) {
        if gm - median > 20.0 {
            add(
                "MARGIN_ABOVE_PEERS", "medium", "毛利率显著高于同业中位数",
                format!("毛利率 {gm}%，同业中位数 {median}%，差异超过 20 个百分点，需核实成本口径与关联交易。"),
                json!({ "year": cur.year, "gross_margin": gm, "peer_median": median }), &mut out,
            );
        }
    }

    if let Some(prev) = prev {
        if let (Some(d1), Some(d0)) = (cur.f("debt_ratio"), prev.f("debt_ratio")) {
            if d1 - d0 >= 10.0 {
                add(
                    "DEBT_JUMP", "high", "资产负债率一年内大幅上升",
                    format!("资产负债率 {d0}% → {d1}%，上升 {} 个百分点，偿债压力快速累积。", round(d1 - d0, 1)),
                    json!({ "from_year": prev.year, "to_year": cur.year, "from": d0, "to": d1 }), &mut out,
                );
            }
        }
    }

    if periods.len() >= 3 {
        let (a, b, c) = (&periods[periods.len() - 3], &periods[periods.len() - 2], &periods[periods.len() - 1]);
        if let (Some(i0), Some(i1), Some(i2)) = (a.f("inventory_days"), b.f("inventory_days"), c.f("inventory_days")) {
            if i1 > i0 && i2 > i1 && i0 > 0.0 && (i2 - i0) / i0 > 0.3 {
                add(
                    "INVENTORY_WORSEN", "medium", "存货周转天数连续两期恶化",
                    format!("存货周转天数 {i0} → {i1} → {i2} 天，累计上升 {}%，存在积压或跌价风险。", round((i2 - i0) / i0 * 100.0, 1)),
                    json!({ "years": [a.year, b.year, c.year], "inventory_days": [i0, i1, i2] }), &mut out,
                );
            }
        }
    }

    if let Some(gr) = cur.f("goodwill_ratio") {
        if gr > 30.0 {
            add(
                "GOODWILL_HEAVY", "high", "商誉占净资产比例过高",
                format!("商誉/净资产 = {}%，超过 30%，存在减值冲击净资产的风险。", round(gr, 1)),
                json!({ "year": cur.year, "goodwill_ratio": gr }), &mut out,
            );
        }
    }

    if let Some(dr) = cur.f("deducted_ratio") {
        if dr < 0.5 {
            let dp = cur.f("deducted_profit");
            let detail = if dr < 0.0 {
                format!(
                    "扣非净利润为负（{} 万元），而净利润为正（{} 万元），盈利完全依赖非经常性损益（如资产处置、重整收益、政府补助）。",
                    round(dp.unwrap_or(0.0), 0),
                    round(cur.f("net_profit").unwrap_or(0.0), 0)
                )
            } else {
                format!("扣非净利润/净利润 = {}，利润较大程度依赖非经常性损益。", round(dr, 2))
            };
            add(
                "LOW_DEDUCTED", "medium", "扣非净利润占比偏低", detail,
                json!({ "year": cur.year, "deducted_ratio": dr, "deducted_profit_wan": dp }), &mut out,
            );
        }
    }

    if let (Some(rg), Some(pg)) = (cur.f("revenue_growth"), cur.f("profit_growth")) {
        if rg > 0.0 && pg - rg > 50.0 {
            add(
                "GROWTH_SCISSOR", "medium", "净利润增速远超营收增速",
                format!("营收同比 {}%，净利润同比 {}%，利润增长缺乏收入支撑。", round(rg, 1), round(pg, 1)),
                json!({ "year": cur.year, "revenue_growth": rg, "profit_growth": pg }), &mut out,
            );
        }
    }

    if periods.len() >= 3 {
        let (a, b, c) = (&periods[periods.len() - 3], &periods[periods.len() - 2], &periods[periods.len() - 1]);
        if let (Some(a0), Some(a1), Some(a2)) = (a.f("ar_days"), b.f("ar_days"), c.f("ar_days")) {
            if a1 > a0 && a2 > a1 && a0 > 0.0 && (a2 - a0) / a0 > 0.3 {
                add(
                    "AR_WORSEN", "medium", "应收账款周转天数持续恶化",
                    format!("应收账款周转天数 {a0} → {a1} → {a2} 天，回款效率下降。"),
                    json!({ "years": [a.year, b.year, c.year], "ar_days": [a0, a1, a2] }), &mut out,
                );
            }
        }
    }

    let order = |level: &str| match level {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    };
    out.sort_by_key(|a| order(a["level"].as_str().unwrap_or("low")));
    out
}

pub fn peer_median(peer: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(rows) = peer.get("rows").and_then(|v| v.as_array()) else { return out };
    for key in PEER_METRICS {
        let mut values: Vec<f64> = rows
            .iter()
            .filter_map(|r| r["metrics"][key].as_f64())
            .collect();
        if values.is_empty() {
            continue;
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = values.len();
        let median = if n % 2 == 1 {
            values[n / 2]
        } else {
            (values[n / 2 - 1] + values[n / 2]) / 2.0
        };
        out.insert((*key).to_string(), json!(round(median, 2)));
    }
    out
}

/// 市值（万元）：从 finance.metrics_json 之外无法获取时返回 None（P3 暂不联网取市值）
pub fn market_cap_wan(_db: &Db, _code: &str) -> Option<f64> {
    None
}

/// 完整分析结果
pub fn analysis(db: &Db, enterprise_id: i64, years: usize, with_peers: bool) -> Result<Value> {
    let ent = db.with(|conn| {
        let row = conn.query_row(
            "SELECT id, name, industry, stock_code, legal_rep, reg_date, data_note, data_status_json
             FROM enterprise WHERE id = ?1",
            [enterprise_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            },
        );
        match row {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    let Some((id, name, industry, stock_code, legal_rep, reg_date, data_note, status_json)) = ent else {
        return Ok(json!({ "error": format!("企业不存在: {enterprise_id}") }));
    };
    let data_status: Value = serde_json::from_str(&status_json).unwrap_or(json!({}));
    let periods = load_periods(db, enterprise_id, years)?;

    if periods.is_empty() {
        return Ok(json!({
            "enterprise": { "id": id, "name": name, "industry": industry, "stock_code": stock_code },
            "available": false,
            "reason": "无财务数据（未采集或非上市企业）",
            "data_status": data_status.get("finance").cloned().unwrap_or(json!("never")),
            "kpi": [], "trends": {}, "dupont": { "rows": [], "attribution": Value::Null },
            "models": {}, "peers": Value::Null, "anomalies": [],
            "data_quality": { "years": 0, "periods": [], "notes": ["请先执行数据源刷新（POST /api/enterprise/{id}/refresh）"] },
        }));
    }

    let peer = if with_peers { build_peers(db, enterprise_id, &industry, years, 6)? } else { Value::Null };
    let median = peer_median(&peer);
    let cur = periods.last().expect("non-empty");
    let market_cap = market_cap_wan(db, &stock_code);

    let models = json!({
        "altman": build_altman(cur, market_cap),
        "piotroski": build_piotroski(&periods),
        "beneish": build_beneish(&periods),
    });

    let anomalies = build_anomalies(&periods, &median);
    let missing_keys: Vec<&str> = METRIC_META
        .iter()
        .filter(|(k, _, _, _, _)| periods.iter().all(|p| p.f(k).is_none()))
        .map(|(k, _, _, _, _)| *k)
        .collect();

    let mut notes: Vec<String> = Vec::new();
    if periods.len() < 2 {
        notes.push("仅有一期财报，同比与 F/M 模型不可用".into());
    }
    if market_cap.is_none() && !stock_code.is_empty() {
        notes.push("未取到总市值，Altman Z 使用 Z'' 口径（账面净资产）".into());
    }
    if industry.is_empty() {
        notes.push("企业未标注行业，同业对标为全库可比".into());
    }

    let mut sources: BTreeSet<String> = BTreeSet::new();
    for p in &periods {
        if !p.source.is_empty() {
            sources.insert(p.source.clone());
        }
    }

    Ok(json!({
        "enterprise": {
            "id": id, "name": name, "industry": industry, "stock_code": stock_code,
            "legal_rep": legal_rep, "reg_date": reg_date, "data_note": data_note,
        },
        "available": true,
        "latest_year": cur.year,
        "data_status": data_status.get("finance").cloned().unwrap_or(json!("never")),
        "kpi": build_kpi(&periods),
        "trends": build_trends(&periods),
        "dupont": build_dupont(&periods),
        "models": models,
        "peers": peer,
        "peer_median": Value::Object(median),
        "anomalies": anomalies,
        "data_quality": {
            "years": periods.len(),
            "periods": periods.iter().map(|p| json!({
                "year": p.year, "report_type": p.report_type, "source": p.source, "derived": p.derived,
            })).collect::<Vec<_>>(),
            "missing_metrics": missing_keys,
            "notes": notes,
        },
    }))
}

/// 确定性 Markdown 财务分析报告（叙述性解读由 Agent 完成）
pub fn report_markdown(db: &Db, enterprise_id: i64, years: usize) -> Result<String> {
    let a = analysis(db, enterprise_id, years, true)?;
    if let Some(err) = a.get("error").and_then(|v| v.as_str()) {
        return Ok(format!("# 金融分析报告\n\n{err}\n"));
    }
    let ent = &a["enterprise"];
    let name = ent["name"].as_str().unwrap_or("");
    if a["available"] != json!(true) {
        return Ok(format!(
            "# {name} 金融分析报告\n\n**结论**：无财务数据（{}）。\n\n数据状态：`{}`。请先刷新数据源或补充人工财报。\n",
            a["reason"].as_str().unwrap_or(""),
            a["data_status"].as_str().unwrap_or("never"),
        ));
    }

    let mut lines: Vec<String> = vec![format!("# {name} 金融分析报告"), String::new()];
    lines.push(format!(
        "- 行业：{}　股票代码：{}",
        ent["industry"].as_str().unwrap_or("—"),
        ent["stock_code"].as_str().unwrap_or("—")
    ));
    let periods = a["data_quality"]["periods"].as_array().cloned().unwrap_or_default();
    let first_year = periods.first().and_then(|p| p["year"].as_str()).unwrap_or("—");
    lines.push(format!(
        "- 分析期间：{}–{}（{} 期年报）",
        first_year,
        a["latest_year"].as_str().unwrap_or("—"),
        a["data_quality"]["years"].as_i64().unwrap_or(0)
    ));
    let sources: BTreeSet<&str> = periods
        .iter()
        .filter_map(|p| p["source"].as_str())
        .filter(|s| !s.is_empty())
        .collect();
    lines.push(format!("- 数据来源：{}", sources.into_iter().collect::<Vec<_>>().join("；")));
    lines.push(String::new());

    lines.push("## 一、关键指标概览".into());
    lines.push(String::new());
    lines.push(format!(
        "| 指标 | {} | 上期 | 同比 |",
        a["latest_year"].as_str().unwrap_or("最新")
    ));
    lines.push("|---|---|---|---|".into());
    for k in a["kpi"].as_array().cloned().unwrap_or_default() {
        if k["available"] != json!(true) {
            continue;
        }
        lines.push(format!(
            "| {}（{}） | {} | {} | {} |",
            k["label"].as_str().unwrap_or(""),
            k["unit"].as_str().unwrap_or(""),
            k["value"],
            if k["prev"].is_null() { "—".into() } else { k["prev"].to_string() },
            match k["yoy"].as_f64() {
                Some(v) => format!("{v}%"),
                None => "—".into(),
            }
        ));
    }
    lines.push(String::new());

    let d = &a["dupont"];
    lines.push("## 二、杜邦分解".into());
    lines.push(String::new());
    lines.push(format!("`{}`", d["formula"].as_str().unwrap_or("")));
    lines.push(String::new());
    lines.push("| 年度 | ROE(%) | 销售净利率(%) | 总资产周转率 | 权益乘数 |".into());
    lines.push("|---|---|---|---|---|".into());
    for r in d["rows"].as_array().cloned().unwrap_or_default() {
        let cell = |v: &Value| if v.is_null() { "—".to_string() } else { v.to_string() };
        lines.push(format!(
            "| {} | {} | {} | {} | {} |",
            r["year"].as_str().unwrap_or(""),
            cell(&r["roe"]),
            cell(&r["net_margin"]),
            cell(&r["asset_turnover"]),
            cell(&r["equity_multiplier"]),
        ));
    }
    if !d["attribution"].is_null() {
        let at = &d["attribution"];
        lines.push(String::new());
        lines.push(format!(
            "**{} → {} ROE 变动 {} 个百分点**，归因：",
            at["from_year"].as_str().unwrap_or(""),
            at["to_year"].as_str().unwrap_or(""),
            at["roe_delta"]
        ));
        for it in at["items"].as_array().cloned().unwrap_or_default() {
            lines.push(format!("- {}：{} 个百分点", it["label"].as_str().unwrap_or(""), it["contrib"]));
        }
    }
    lines.push(String::new());

    lines.push("## 三、财务预警模型".into());
    lines.push(String::new());
    let m = &a["models"];
    let z2 = &m["altman"]["z2"];
    lines.push(format!(
        "- **Altman Z''-Score**：{}{}",
        if z2["available"] == json!(true) { z2["score"].to_string() } else { "不可计算".into() },
        if z2["available"] == json!(true) {
            format!("（{}，{}）", z2["verdict"].as_str().unwrap_or(""), z2["basis"].as_str().unwrap_or(""))
        } else {
            format!("，缺 {}", z2["missing"].to_string())
        }
    ));
    let z = &m["altman"]["z"];
    lines.push(format!(
        "- **Altman Z-Score**：{}{}",
        if z["available"] == json!(true) { z["score"].to_string() } else { "不可计算".into() },
        if z["available"] == json!(true) {
            format!("（{}，{}）", z["verdict"].as_str().unwrap_or(""), z["basis"].as_str().unwrap_or(""))
        } else {
            format!("，缺 {}", z["missing"].to_string())
        }
    ));
    let f = &m["piotroski"];
    lines.push(format!(
        "- **Piotroski F-Score**：{}/{}{}{}",
        f["score"],
        f["max_score"],
        f["verdict"].as_str().map(|v| format!("（{v}）")).unwrap_or_default(),
        f["note"].as_str().filter(|s| !s.is_empty()).map(|s| format!("　{s}")).unwrap_or_default(),
    ));
    let b = &m["beneish"];
    lines.push(format!(
        "- **Beneish M-Score**：{}{}",
        if b["available"] == json!(true) { b["score"].to_string() } else { "不可计算".into() },
        if b["available"] == json!(true) {
            format!("（{}）", b["verdict"].as_str().unwrap_or(""))
        } else {
            format!("，缺 {}", b["missing"].to_string())
        }
    ));
    if let Some(note) = b["note"].as_str().filter(|s| !s.is_empty()) {
        lines.push(format!("  - {note}"));
    }
    lines.push(String::new());

    lines.push("## 四、异常勾稽".into());
    lines.push(String::new());
    let anomalies = a["anomalies"].as_array().cloned().unwrap_or_default();
    if anomalies.is_empty() {
        lines.push("- 未触发异常规则（在现有数据范围内）。".into());
    } else {
        for an in anomalies {
            lines.push(format!(
                "- **[{}] {}**：{}",
                an["level"].as_str().unwrap_or(""),
                an["title"].as_str().unwrap_or(""),
                an["detail"].as_str().unwrap_or("")
            ));
        }
    }
    lines.push(String::new());

    if let Some(rows) = a["peers"]["rows"].as_array() {
        if !rows.is_empty() {
            lines.push("## 五、同业对标".into());
            lines.push(String::new());
            let metrics = a["peers"]["metrics"].as_array().cloned().unwrap_or_default();
            lines.push(format!(
                "| 企业 | {} |",
                metrics
                    .iter()
                    .map(|m| m["label"].as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
            lines.push(format!("|{}", "---|".repeat(metrics.len() + 1)));
            for r in rows {
                let mut cells = vec![if r["is_self"] == json!(true) {
                    format!("**{}**", r["name"].as_str().unwrap_or(""))
                } else {
                    r["name"].as_str().unwrap_or("").to_string()
                }];
                for m in &metrics {
                    let key = m["key"].as_str().unwrap_or("");
                    let v = &r["metrics"][key];
                    cells.push(if v.is_null() {
                        "—".into()
                    } else {
                        format!("{}{}", v, m["unit"].as_str().unwrap_or(""))
                    });
                }
                lines.push(format!("| {} |", cells.join(" | ")));
            }
            lines.push(String::new());
        }
    }

    lines.push("## 六、数据质量说明".into());
    lines.push(String::new());
    lines.push(format!("- 覆盖期数：{} 期年报", a["data_quality"]["years"]));
    if let Some(missing) = a["data_quality"]["missing_metrics"].as_array() {
        if !missing.is_empty() {
            lines.push(format!(
                "- 全期缺失指标：{}",
                missing
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    for note in a["data_quality"]["notes"].as_array().cloned().unwrap_or_default() {
        lines.push(format!("- {}", note.as_str().unwrap_or("")));
    }
    lines.push(String::new());
    lines.push("> 数据来自公开信源，模型结果为规则化测算，不构成投资建议。".into());
    Ok(lines.join("\n"))
}

/// 全库财务概览（选择器与横向筛选）
pub fn overview(db: &Db, years: usize) -> Result<Value> {
    let ents: Vec<(i64, String, String, String)> = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT id, name, industry, stock_code FROM enterprise ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut items = Vec::new();
    for (id, name, industry, stock_code) in ents {
        let periods = load_periods(db, id, years)?;
        let cur = periods.last();
        items.push(json!({
            "enterprise_id": id,
            "name": name,
            "industry": industry,
            "stock_code": stock_code,
            "has_finance": cur.is_some(),
            "years": periods.len(),
            "latest_year": cur.map(|p| p.year.clone()),
            "revenue": r2(cur.and_then(|p| p.f("revenue"))),
            "net_profit": r2(cur.and_then(|p| p.f("net_profit"))),
            "revenue_growth": r2(cur.and_then(|p| p.f("revenue_growth"))),
            "gross_margin": r2(cur.and_then(|p| p.f("gross_margin"))),
            "net_margin": r2(cur.and_then(|p| p.f("net_margin"))),
            "roe": r2(cur.and_then(|p| p.f("roe"))),
            "debt_ratio": r2(cur.and_then(|p| p.f("debt_ratio"))),
        }));
    }
    Ok(json!({ "total": items.len(), "items": items }))
}

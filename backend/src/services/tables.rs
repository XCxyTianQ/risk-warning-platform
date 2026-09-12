//! 表格对象（TableDoc）：在线创建 / 在线编辑 / 读取结果入库的共同容器。
//!
//! 核心设计：
//!  * **表是平台里的一等对象**，不是附件。上传/截图/粘贴只是它的三种"填充方式"。
//!  * **单元格级溯源**：每个格子记 source（user / vision / paste / public）与 confidence，
//!    视觉识别的格子默认标记为待确认，人工改过的格子转为 user。
//!  * **单位/口径/期间是元数据**，不是普通单元格（万元与元差 10000 倍，必须在表头显式声明）。
//!  * **科目映射**：中文科目名 → 引擎标准字段（`revenue_wan` 等），带别名词典自动映射 +
//!    人工指认；映射结果决定能否入库。
//!  * **勾稽校验**：用会计恒等式（资产 = 负债 + 权益、资产负债率一致性等）验证读数，
//!    把视觉模型的幻觉挡在入库之前 —— 平台对"数据"也做风险控制。
//!  * **不覆盖公开信源**：同一 (企业, 年, 报告期) 已有公开数据时默认跳过并报告差异。

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::db::Db;
use crate::util::now_db;

/// 引擎字段元数据：(key, 标签, 类型(amount|ratio), 单位, 分组, 别名…)
///
/// key 必须与 `services::finance` 的 `metrics_json` 口径一致：
/// 绝对额用 `_wan` 后缀（单位：万元），比率/倍数不带后缀。
pub struct FieldMeta {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub unit: &'static str,
    pub aliases: &'static [&'static str],
}

pub const FIELDS: &[FieldMeta] = &[
    FieldMeta { key: "revenue_wan", label: "营业总收入", kind: "amount", unit: "万元",
        aliases: &["营业总收入", "营业收入", "主营业务收入", "营业总额", "一、营业总收入", "营收", "revenue"] },
    FieldMeta { key: "operating_cost_wan", label: "营业成本", kind: "amount", unit: "万元",
        aliases: &["营业成本", "主营业务成本", "营业总成本"] },
    FieldMeta { key: "operating_profit_wan", label: "营业利润", kind: "amount", unit: "万元",
        aliases: &["营业利润", "三、营业利润"] },
    FieldMeta { key: "net_profit_total_wan", label: "净利润（含少数股东）", kind: "amount", unit: "万元",
        aliases: &["净利润", "五、净利润", "净利润(含少数股东)", "净利润（含少数股东）"] },
    FieldMeta { key: "net_profit_wan", label: "归母净利润", kind: "amount", unit: "万元",
        aliases: &["归属于母公司股东的净利润", "归属于母公司所有者的净利润", "归母净利润",
                   "归属母公司股东的净利润", "归属于上市公司股东的净利润", "归属于母公司净利润"] },
    FieldMeta { key: "deducted_profit_wan", label: "扣非净利润", kind: "amount", unit: "万元",
        aliases: &["扣除非经常性损益后的净利润", "扣非净利润", "扣除非经常性损益的净利润"] },
    FieldMeta { key: "total_assets_wan", label: "资产总计", kind: "amount", unit: "万元",
        aliases: &["资产总计", "资产总额", "总资产"] },
    FieldMeta { key: "total_liabilities_wan", label: "负债合计", kind: "amount", unit: "万元",
        aliases: &["负债合计", "负债总计", "负债总额", "总负债"] },
    FieldMeta { key: "equity_wan", label: "所有者权益合计", kind: "amount", unit: "万元",
        aliases: &["所有者权益合计", "股东权益合计", "所有者权益(或股东权益)合计", "净资产",
                   "归属于母公司所有者权益合计", "所有者权益"] },
    FieldMeta { key: "current_assets_wan", label: "流动资产合计", kind: "amount", unit: "万元",
        aliases: &["流动资产合计", "流动资产"] },
    FieldMeta { key: "current_liabilities_wan", label: "流动负债合计", kind: "amount", unit: "万元",
        aliases: &["流动负债合计", "流动负债"] },
    FieldMeta { key: "accounts_receivable_wan", label: "应收账款", kind: "amount", unit: "万元",
        aliases: &["应收账款", "应收账款净额", "应收票据及应收账款"] },
    FieldMeta { key: "inventory_wan", label: "存货", kind: "amount", unit: "万元",
        aliases: &["存货", "存货净额"] },
    FieldMeta { key: "goodwill_wan", label: "商誉", kind: "amount", unit: "万元",
        aliases: &["商誉"] },
    FieldMeta { key: "fixed_assets_wan", label: "固定资产", kind: "amount", unit: "万元",
        aliases: &["固定资产", "固定资产净额"] },
    FieldMeta { key: "ocf_wan", label: "经营活动现金流净额", kind: "amount", unit: "万元",
        aliases: &["经营活动产生的现金流量净额", "经营活动现金流量净额", "经营现金流", "经营活动现金流净额"] },
    FieldMeta { key: "capex_wan", label: "资本开支", kind: "amount", unit: "万元",
        aliases: &["购建固定资产、无形资产和其他长期资产支付的现金", "资本开支", "资本性支出"] },
    FieldMeta { key: "selling_expense_wan", label: "销售费用", kind: "amount", unit: "万元",
        aliases: &["销售费用", "营业费用"] },
    FieldMeta { key: "admin_expense_wan", label: "管理费用", kind: "amount", unit: "万元",
        aliases: &["管理费用"] },
    FieldMeta { key: "finance_expense_wan", label: "财务费用", kind: "amount", unit: "万元",
        aliases: &["财务费用"] },
    FieldMeta { key: "rd_expense_wan", label: "研发费用", kind: "amount", unit: "万元",
        aliases: &["研发费用", "研发支出"] },
    FieldMeta { key: "gross_margin", label: "毛利率", kind: "ratio", unit: "%",
        aliases: &["毛利率", "销售毛利率"] },
    FieldMeta { key: "net_margin", label: "销售净利率", kind: "ratio", unit: "%",
        aliases: &["销售净利率", "净利率"] },
    FieldMeta { key: "roe", label: "净资产收益率", kind: "ratio", unit: "%",
        aliases: &["净资产收益率", "roe", "加权平均净资产收益率", "净资产收益率ROE"] },
    FieldMeta { key: "roa", label: "总资产报酬率", kind: "ratio", unit: "%",
        aliases: &["总资产报酬率", "roa", "总资产净利率"] },
    FieldMeta { key: "debt_ratio", label: "资产负债率", kind: "ratio", unit: "%",
        aliases: &["资产负债率", "负债率"] },
    FieldMeta { key: "current_ratio", label: "流动比率", kind: "ratio", unit: "倍",
        aliases: &["流动比率"] },
    FieldMeta { key: "quick_ratio", label: "速动比率", kind: "ratio", unit: "倍",
        aliases: &["速动比率"] },
    FieldMeta { key: "equity_multiplier", label: "权益乘数", kind: "ratio", unit: "倍",
        aliases: &["权益乘数"] },
    FieldMeta { key: "asset_turnover", label: "总资产周转率", kind: "ratio", unit: "次",
        aliases: &["总资产周转率", "总资产周转次数"] },
    FieldMeta { key: "ar_days", label: "应收账款周转天数", kind: "ratio", unit: "天",
        aliases: &["应收账款周转天数"] },
    FieldMeta { key: "inventory_days", label: "存货周转天数", kind: "ratio", unit: "天",
        aliases: &["存货周转天数"] },
    FieldMeta { key: "revenue_growth", label: "营业总收入增速", kind: "ratio", unit: "%",
        aliases: &["营业总收入增速", "营业收入增长率", "营收增速", "营业收入同比增长"] },
    FieldMeta { key: "profit_growth", label: "归母净利润增速", kind: "ratio", unit: "%",
        aliases: &["归母净利润增速", "净利润增长率", "净利润增速"] },
    FieldMeta { key: "ocf_to_revenue", label: "经营现金流/营业收入", kind: "ratio", unit: "倍",
        aliases: &["经营现金流/营业收入", "现金流营收比"] },
    FieldMeta { key: "ocf_to_profit", label: "现金含量", kind: "ratio", unit: "倍",
        aliases: &["现金含量", "经营现金流/净利润", "净现比"] },
    FieldMeta { key: "bvps", label: "每股净资产", kind: "ratio", unit: "元",
        aliases: &["每股净资产"] },
];

pub fn field_meta(key: &str) -> Option<&'static FieldMeta> {
    FIELDS.iter().find(|f| f.key == key)
}

/// 别名 → 引擎字段（大小写不敏感、去空白与标点）
pub fn match_field(label: &str) -> Option<&'static str> {
    let norm = normalize_label(label);
    if norm.is_empty() {
        return None;
    }
    for f in FIELDS {
        if normalize_label(f.label) == norm || normalize_label(f.key) == norm {
            return Some(f.key);
        }
        for a in f.aliases {
            if normalize_label(a) == norm {
                return Some(f.key);
            }
        }
    }
    None
}

fn normalize_label(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !"：:＊*·、,，.。()（）「」【】".contains(*c))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

/// 内置模板：(kind, 标题, 行科目 key 列表)
pub const TEMPLATES: &[(&str, &str, &[&str])] = &[
    (
        "income",
        "利润表",
        &[
            "revenue_wan",
            "operating_cost_wan",
            "selling_expense_wan",
            "admin_expense_wan",
            "rd_expense_wan",
            "finance_expense_wan",
            "operating_profit_wan",
            "net_profit_total_wan",
            "net_profit_wan",
            "deducted_profit_wan",
        ],
    ),
    (
        "balance",
        "资产负债表",
        &[
            "current_assets_wan",
            "accounts_receivable_wan",
            "inventory_wan",
            "fixed_assets_wan",
            "goodwill_wan",
            "total_assets_wan",
            "current_liabilities_wan",
            "total_liabilities_wan",
            "equity_wan",
        ],
    ),
    (
        "cashflow",
        "现金流量表",
        &["ocf_wan", "capex_wan"],
    ),
    (
        "kpi",
        "关键指标表",
        &[
            "revenue_wan",
            "net_profit_wan",
            "total_assets_wan",
            "total_liabilities_wan",
            "equity_wan",
            "ocf_wan",
            "gross_margin",
            "net_margin",
            "roe",
            "debt_ratio",
        ],
    ),
];

fn template_rows(kind: &str) -> Vec<&'static str> {
    TEMPLATES
        .iter()
        .find(|(k, _, _)| *k == kind)
        .map(|(_, _, rows)| rows.to_vec())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 表格结构
// ---------------------------------------------------------------------------

/// 空表结构：给定模板行 + 若干期间列
pub fn build_sheet(kind: &str, periods: &[(String, String)]) -> (Value, Map<String, Value>) {
    let columns: Vec<Value> = periods
        .iter()
        .enumerate()
        .map(|(i, (period, report_type))| {
            json!({
                "key": format!("c{}", i + 1),
                "label": format!("{period}{}", if report_type.is_empty() { String::new() } else { report_type.clone() }),
                "period": period,
                "report_type": if report_type.is_empty() { "年报" } else { report_type },
                "type": "number",
            })
        })
        .collect();

    let rows: Vec<Value> = template_rows(kind)
        .iter()
        .enumerate()
        .map(|(i, key)| {
            let label = field_meta(key).map(|f| f.label).unwrap_or(key);
            json!({
                "key": format!("r{}", i + 1),
                "label": label,
                "field": key,
                "cells": {},
            })
        })
        .collect();

    let mut mapping = Map::new();
    for r in &rows {
        if let Some(field) = r.get("field").and_then(|v| v.as_str()) {
            if !field.is_empty() {
                mapping.insert(field.to_string(), r.get("key").cloned().unwrap_or(json!("")));
            }
        }
    }

    (
        json!({ "columns": columns, "rows": rows, "meta": {} }),
        mapping,
    )
}

// ---------------------------------------------------------------------------
// 工作簿（多工作表）：sheet_json 存 {"sheets":[…],"active":"s1"}
// ---------------------------------------------------------------------------

/// 空白工作表：列标题与行标题全部留空，由用户自己填（不再强制模板）
pub fn blank_sheet(rows: usize, cols: usize) -> Value {
    let columns: Vec<Value> = (0..cols)
        .map(|i| {
            json!({
                "key": format!("c{}", i + 1),
                "label": "",
                "period": "",
                "report_type": "",
                "type": "number",
            })
        })
        .collect();
    let rows: Vec<Value> = (0..rows)
        .map(|i| json!({ "key": format!("r{}", i + 1), "label": "", "field": "", "cells": {} }))
        .collect();
    json!({ "columns": columns, "rows": rows, "meta": {} })
}

/// 把任意来源的 sheet_json 归一化成工作簿：
///  * 已是工作簿 → 原样（补 key/name）
///  * 旧单表 `{columns,rows}` → 包成一个名为「Sheet1」的工作表
pub fn normalize_workbook(raw: &Value) -> Value {
    if let Some(arr) = raw.get("sheets").and_then(|v| v.as_array()) {
        let sheets: Vec<Value> = arr
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let key = s.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let key = if key.is_empty() { format!("s{}", i + 1) } else { key };
                let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = if name.is_empty() { format!("Sheet{}", i + 1) } else { name };
                json!({
                    "key": key,
                    "name": name,
                    "columns": s.get("columns").cloned().unwrap_or(json!([])),
                    "rows": s.get("rows").cloned().unwrap_or(json!([])),
                    "mapping": s.get("mapping").cloned().unwrap_or(json!({})),
                })
            })
            .collect();
        let sheets = if sheets.is_empty() {
            vec![json!({ "key": "s1", "name": "Sheet1", "columns": [], "rows": [], "mapping": {} })]
        } else {
            sheets
        };
        let active = raw.get("active").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let active = if sheets.iter().any(|s| s.get("key").and_then(|v| v.as_str()) == Some(active.as_str())) {
            active
        } else {
            sheets[0].get("key").and_then(|v| v.as_str()).unwrap_or("s1").to_string()
        };
        return json!({ "sheets": sheets, "active": active });
    }
    // 旧结构
    json!({
        "sheets": [{
            "key": "s1",
            "name": "Sheet1",
            "columns": raw.get("columns").cloned().unwrap_or(json!([])),
            "rows": raw.get("rows").cloned().unwrap_or(json!([])),
            "mapping": {},
        }],
        "active": "s1",
    })
}

/// 取工作簿里的当前工作表（不存在时返回空表）
pub fn sheet_of(workbook: &Value, key: &str) -> Value {
    workbook
        .get("sheets")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|s| s.get("key").and_then(|v| v.as_str()) == Some(key))
                .cloned()
        })
        .unwrap_or_else(|| json!({ "key": key, "name": "Sheet1", "columns": [], "rows": [], "mapping": {} }))
}

/// 依据行标题重建/补全科目映射（用户改过标题时也能自动跟上）
pub fn auto_map(sheet: &Value) -> Map<String, Value> {
    let mut mapping = Map::new();
    for row in sheet.get("rows").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let key = row.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if key.is_empty() {
            continue;
        }
        // 1) 显式 field 优先
        if let Some(field) = row.get("field").and_then(|v| v.as_str()) {
            if !field.is_empty() {
                mapping.insert(field.to_string(), json!(key));
                continue;
            }
        }
        // 2) 别名词典
        let label = row.get("label").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(field) = match_field(label) {
            mapping.entry(field.to_string()).or_insert(json!(key));
        }
    }
    mapping
}

fn cell_value(sheet: &Value, row_key: &str, col_key: &str) -> Option<f64> {
    let rows = sheet.get("rows")?.as_array()?;
    let row = rows.iter().find(|r| r.get("key").and_then(|v| v.as_str()) == Some(row_key))?;
    let cell = row.get("cells")?.get(col_key)?;
    match cell {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace(',', "").parse::<f64>().ok(),
        Value::Object(o) => o.get("value").and_then(|v| {
            v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().replace(',', "").parse::<f64>().ok()))
        }),
        _ => None,
    }
}

fn unit_factor(unit: &str) -> f64 {
    match unit {
        "元" => 0.0001,
        "亿元" => 10_000.0,
        _ => 1.0, // 万元
    }
}

// ---------------------------------------------------------------------------
// 勾稽校验
// ---------------------------------------------------------------------------

pub fn validate(doc: &TableDoc) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut push = |level: &str, code: &str, message: String, row: &str, col: &str| {
        issues.push(json!({
            "level": level, "code": code, "message": message, "row": row, "col": col,
        }));
    };

    if doc.enterprise_id.is_none() {
        push("error", "NO_ENTERPRISE", "表格未绑定企业，入库前需要选择企业".into(), "", "");
    }
    let columns = doc.sheet.get("columns").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if columns.is_empty() {
        push("error", "NO_PERIOD", "至少需要一列期间（如 2025 年报）".into(), "", "");
    }
    let mut seen_periods: Vec<String> = Vec::new();
    for c in &columns {
        let key = c.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let period = c.get("period").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if period.is_empty() {
            push("error", "EMPTY_PERIOD", "存在没有期间的列（需填年份/报告期）".into(), "", key);
        } else if seen_periods.contains(&period) {
            push("warn", "DUP_PERIOD", format!("期间 {period} 重复，入库时会互相覆盖"), "", key);
        } else {
            seen_periods.push(period);
        }
    }

    let mapped: Vec<&str> = doc.mapping.keys().map(|s| s.as_str()).collect();
    if !mapped.iter().any(|k| ["revenue_wan", "net_profit_wan", "total_assets_wan"].contains(k)) {
        push(
            "error",
            "NO_CORE_FIELD",
            "尚未映射任何核心科目（营业收入 / 归母净利润 / 资产总计 至少其一）".into(),
            "",
            "",
        );
    }
    if !mapped.contains(&"total_assets_wan") {
        push("warn", "NO_ASSETS", "缺「资产总计」：Z″ 值与 ROA 不可计算".into(), "", "");
    }
    if !mapped.contains(&"ocf_wan") {
        push("warn", "NO_OCF", "缺「经营活动现金流净额」：现金流质量与部分异常规则不可用".into(), "", "");
    }
    if seen_periods.len() < 2 {
        push("warn", "ONLY_ONE_PERIOD", "只有一期数据：同比、趋势与 Beneish M-Score 不可用".into(), "", "");
    }

    // 待确认的模型识别结果：财报数字读错一位就全盘皆错 —— 确认前阻止入库
    let mut unconfirmed: Vec<String> = Vec::new();
    for r in doc.sheet.get("rows").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let row_key = r.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let label = r.get("label").and_then(|v| v.as_str()).unwrap_or(row_key);
        for (col, cell) in r.get("cells").and_then(|v| v.as_object()).cloned().unwrap_or_default() {
            if cell.get("source").and_then(|v| v.as_str()) == Some("vision") {
                let col_label = columns
                    .iter()
                    .find(|c| c.get("key").and_then(|v| v.as_str()) == Some(col.as_str()))
                    .and_then(|c| c.get("label").and_then(|v| v.as_str()))
                    .unwrap_or(col.as_str());
                unconfirmed.push(format!("{label}@{col_label}"));
            }
        }
    }
    if !unconfirmed.is_empty() {
        push(
            "error",
            "VISION_UNCONFIRMED",
            format!(
                "有 {} 个由图片识别的数字尚未确认（{}）—— 请在表格里核对后点「确认识别结果」",
                unconfirmed.len(),
                unconfirmed.iter().take(5).cloned().collect::<Vec<_>>().join("、")
            ),
            "",
            "",
        );
    }

    // 逐列勾稽（用映射后的科目值）
    let get = |field: &str, col: &str| -> Option<f64> {
        doc.mapping.get(field).and_then(|v| v.as_str()).and_then(|row| cell_value(&doc.sheet, row, col))
    };
    for c in &columns {
        let col = c.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let label = c.get("label").and_then(|v| v.as_str()).unwrap_or(col);
        let ta = get("total_assets_wan", col);
        let tl = get("total_liabilities_wan", col);
        let eq = get("equity_wan", col);
        // 资产 = 负债 + 所有者权益
        if let (Some(ta), Some(tl), Some(eq)) = (ta, tl, eq) {
            let diff = (ta - (tl + eq)).abs();
            let tol = (ta.abs() * 0.01).max(1.0);
            if diff > tol {
                push(
                    "error",
                    "BALANCE_MISMATCH",
                    format!("{label}：资产总计 {ta} ≠ 负债 {tl} + 权益 {eq}（差 {diff:.2}，容差 {tol:.2}）"),
                    "",
                    col,
                );
            }
        } else if ta.is_some() && tl.is_some() && eq.is_none() {
            push(
                "warn",
                "MISSING_EQUITY",
                format!("{label}：缺「所有者权益合计」，无法做 资产=负债+权益 勾稽；ROE、权益乘数与 Altman Z″ 也不可算"),
                "",
                col,
            );
        }
        // 资产负债率一致性与取值域
        if let (Some(ta), Some(tl)) = (ta, tl) {
            if ta != 0.0 {
                let ratio = tl / ta * 100.0;
                if ratio < 0.0 || ratio > 150.0 {
                    push(
                        "warn",
                        "DEBT_RATIO_RANGE",
                        format!("{label}：由负债/资产推算的资产负债率为 {ratio:.2}%，超出常见区间，请核对单位与口径"),
                        "",
                        col,
                    );
                }
                if let Some(dr) = get("debt_ratio", col) {
                    if (dr - ratio).abs() > 1.0 {
                        push(
                            "error",
                            "DEBT_RATIO_MISMATCH",
                            format!("{label}：填写的资产负债率 {dr:.2}% 与负债/资产推算值 {ratio:.2}% 不一致"),
                            "",
                            col,
                        );
                    }
                }
            }
        }
        // 净利润方向与营收异常
        if let (Some(rev), Some(np)) = (get("revenue_wan", col), get("net_profit_wan", col)) {
            if rev == 0.0 && np != 0.0 {
                push("warn", "REVENUE_ZERO", format!("{label}：营业收入为 0 但有净利润，请核对"), "", col);
            }
            if rev != 0.0 && np.abs() > rev.abs() * 3.0 {
                push(
                    "warn",
                    "PROFIT_OUTLIER",
                    format!("{label}：净利润 {np} 与营业收入 {rev} 量级差异过大，请核对单位"),
                    "",
                    col,
                );
            }
        }
        // 空单元格提示
        for row in doc.sheet.get("rows").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            let row_key = row.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let field = doc.mapping.iter().find(|(_, v)| v.as_str() == Some(row_key)).map(|(k, _)| k.clone());
            if field.is_some() && cell_value(&doc.sheet, row_key, col).is_none() {
                push(
                    "info",
                    "EMPTY_CELL",
                    format!(
                        "{label}：{} 未填",
                        row.get("label").and_then(|v| v.as_str()).unwrap_or(row_key)
                    ),
                    row_key,
                    col,
                );
            }
        }
    }

    let errors = issues.iter().filter(|i| i["level"] == "error").count();
    let warnings = issues.iter().filter(|i| i["level"] == "warn").count();
    json!({
        "ok": errors == 0,
        "errors": errors,
        "warnings": warnings,
        "issues": issues,
    })
}

// ---------------------------------------------------------------------------
// 文档读写
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TableDoc {
    pub id: i64,
    pub enterprise_id: Option<i64>,
    pub title: String,
    pub kind: String,
    pub unit: String,
    pub scope: String,
    pub period_type: String,
    pub currency: String,
    /// 当前工作表（columns/rows）—— 所有既有逻辑都只面对它
    pub sheet: Value,
    /// 工作簿：{"sheets":[…],"active":"s1"}
    pub workbook: Value,
    /// 当前 sheet 的科目映射
    pub mapping: Map<String, Value>,
    /// 表格级脚本宏：[{name, code, updated_at}]
    pub macros: Value,
    pub status: String,
    pub version: i64,
    pub origin: String,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

impl TableDoc {
    pub fn active_key(&self) -> String {
        self.workbook
            .get("active")
            .and_then(|v| v.as_str())
            .unwrap_or("s1")
            .to_string()
    }

    /// 工作表清单（供前端页签）
    pub fn sheet_list(&self) -> Vec<Value> {
        self.workbook
            .get("sheets")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|s| {
                        let cols = s.get("columns").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                        let rows = s.get("rows").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                        json!({
                            "key": s.get("key"),
                            "name": s.get("name"),
                            "columns": cols,
                            "rows": rows,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 把当前 sheet 写回工作簿里对应的槽位
    pub fn write_back(&mut self) {
        let key = self.active_key();
        if let Some(arr) = self.workbook.get_mut("sheets").and_then(|v| v.as_array_mut()) {
            for s in arr.iter_mut() {
                if s.get("key").and_then(|v| v.as_str()) == Some(key.as_str()) {
                    let sheet_mapping = self.mapping.clone();
                    if let Some(obj) = s.as_object_mut() {
                        obj.insert("columns".into(), self.sheet.get("columns").cloned().unwrap_or(json!([])));
                        obj.insert("rows".into(), self.sheet.get("rows").cloned().unwrap_or(json!([])));
                        obj.insert("mapping".into(), Value::Object(sheet_mapping));
                    }
                    return;
                }
            }
        }
    }

    /// 切换当前工作表（先把当前 sheet 写回）
    pub fn switch_sheet(&mut self, key: &str) {
        self.write_back();
        let exists = self
            .workbook
            .get("sheets")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().any(|s| s.get("key").and_then(|v| v.as_str()) == Some(key)))
            .unwrap_or(false);
        if !exists {
            return;
        }
        if let Some(obj) = self.workbook.as_object_mut() {
            obj.insert("active".into(), json!(key));
        }
        let sheet = sheet_of(&self.workbook, key);
        self.sheet = json!({
            "columns": sheet.get("columns").cloned().unwrap_or(json!([])),
            "rows": sheet.get("rows").cloned().unwrap_or(json!([])),
            "meta": sheet.get("meta").cloned().unwrap_or(json!({})),
        });
        self.mapping = sheet
            .get("mapping")
            .and_then(|v| v.as_object().cloned())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| auto_map(&self.sheet));
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "enterprise_id": self.enterprise_id,
            "title": self.title,
            "kind": self.kind,
            "unit": self.unit,
            "scope": self.scope,
            "period_type": self.period_type,
            "currency": self.currency,
            "sheet": self.sheet,
            "sheets": self.sheet_list(),
            "workbook": self.workbook,
            "active": self.active_key(),
            "mapping": self.mapping,
            "macros": self.macros,
            "status": self.status,
            "version": self.version,
            "origin": self.origin,
            "note": self.note,
            "created_at": crate::util::db_to_iso(&self.created_at),
            "updated_at": crate::util::db_to_iso(&self.updated_at),
        })
    }
}

const COLS: &str = "id, enterprise_id, title, kind, unit, scope, period_type, currency,
                    sheet_json, mapping_json, macro_json, status, version, origin, note, created_at, updated_at";

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TableDoc> {
    let sheet_raw: String = r.get(8)?;
    let mapping: String = r.get(9)?;
    let macros_raw: String = r.get(10)?;
    let raw: Value = serde_json::from_str(&sheet_raw).unwrap_or_else(|_| json!({}));
    let workbook = normalize_workbook(&raw);
    let active = workbook
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("s1")
        .to_string();
    let active_sheet = sheet_of(&workbook, &active);
    let sheet = json!({
        "columns": active_sheet.get("columns").cloned().unwrap_or(json!([])),
        "rows": active_sheet.get("rows").cloned().unwrap_or(json!([])),
        "meta": active_sheet.get("meta").cloned().unwrap_or(json!({})),
    });
    let mapping_map = serde_json::from_str::<Value>(&mapping)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    Ok(TableDoc {
        id: r.get(0)?,
        enterprise_id: r.get(1)?,
        title: r.get(2)?,
        kind: r.get(3)?,
        unit: r.get(4)?,
        scope: r.get(5)?,
        period_type: r.get(6)?,
        currency: r.get(7)?,
        sheet,
        workbook,
        mapping: mapping_map,
        macros: serde_json::from_str(&macros_raw).unwrap_or_else(|_| json!([])),
        status: r.get(11)?,
        version: r.get(12)?,
        origin: r.get(13)?,
        note: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

pub fn get(db: &Db, id: i64) -> Result<Option<TableDoc>> {
    db.with(|conn| {
        let row = conn
            .query_row(&format!("SELECT {COLS} FROM table_doc WHERE id = ?1"), [id], map_row)
            .optional()?;
        Ok(row)
    })
}

pub fn list(db: &Db, enterprise_id: Option<i64>, status: Option<&str>) -> Result<Value> {
    let items = db.with(|conn| {
        let mut sql = String::from(
            "SELECT t.id, t.enterprise_id, e.name, t.title, t.kind, t.unit, t.scope, t.period_type,
                    t.status, t.version, t.origin, t.updated_at,
                    json_array_length(json_extract(t.sheet_json, '$.sheets[0].columns')),
                    json_array_length(json_extract(t.sheet_json, '$.sheets[0].rows')),
                    json_array_length(json_extract(t.sheet_json, '$.sheets')),
                    json_extract(t.sheet_json, '$.active'),
                    json_array_length(json_extract(t.sheet_json, '$.columns')),
                    json_array_length(json_extract(t.sheet_json, '$.rows'))
             FROM table_doc t LEFT JOIN enterprise e ON e.id = t.enterprise_id WHERE 1 = 1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(id) = enterprise_id {
            sql.push_str(" AND t.enterprise_id = ?");
            args.push(Box::new(id));
        }
        if let Some(s) = status {
            if !s.is_empty() {
                sql.push_str(" AND t.status = ?");
                args.push(Box::new(s.to_string()));
            }
        }
        sql.push_str(" ORDER BY t.updated_at DESC, t.id DESC LIMIT 200");
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(params.as_slice(), |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "enterprise_id": r.get::<_, Option<i64>>(1)?,
                    "enterprise": r.get::<_, Option<String>>(2)?,
                    "title": r.get::<_, String>(3)?,
                    "kind": r.get::<_, String>(4)?,
                    "unit": r.get::<_, String>(5)?,
                    "scope": r.get::<_, String>(6)?,
                    "period_type": r.get::<_, String>(7)?,
                    "status": r.get::<_, String>(8)?,
                    "version": r.get::<_, i64>(9)?,
                    "origin": r.get::<_, String>(10)?,
                    "updated_at": crate::util::db_to_iso(&r.get::<_, String>(11)?),
                    "columns": r.get::<_, Option<i64>>(12)?.or(r.get::<_, Option<i64>>(16)?).unwrap_or(0),
                    "rows": r.get::<_, Option<i64>>(13)?.or(r.get::<_, Option<i64>>(17)?).unwrap_or(0),
                    "sheet_count": r.get::<_, Option<i64>>(14)?.unwrap_or(1),
                    "active": r.get::<_, Option<String>>(15)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": items.len(), "items": items }))
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    db: &Db,
    enterprise_id: Option<i64>,
    title: &str,
    kind: &str,
    periods: &[(String, String)],
    unit: &str,
    scope: &str,
    period_type: &str,
    origin: &str,
) -> Result<Value> {
    // 空白表格（默认）：列标题与行标题都留空，用户自己填；模板仅在显式选择模板时使用
    let (sheet, mapping) = if kind == "blank" || kind.is_empty() {
        (blank_sheet(8, 4), Map::<String, Value>::new())
    } else {
        build_sheet(kind, periods)
    };
    let sheet_name = if kind == "blank" || kind.is_empty() {
        "Sheet1"
    } else {
        TEMPLATES
            .iter()
            .find(|(k, _, _)| *k == kind)
            .map(|(_, t, _)| *t)
            .unwrap_or("Sheet1")
    };
    let workbook = json!({
        "sheets": [{
            "key": "s1",
            "name": sheet_name,
            "columns": sheet.get("columns").cloned().unwrap_or(json!([])),
            "rows": sheet.get("rows").cloned().unwrap_or(json!([])),
            "mapping": Value::Object(mapping.clone()),
        }],
        "active": "s1",
    });
    let now = now_db();
    let title = if title.trim().is_empty() {
        TEMPLATES
            .iter()
            .find(|(k, _, _)| *k == kind)
            .map(|(_, t, _)| format!("{t}（新建）"))
            .unwrap_or_else(|| "空白表格".to_string())
    } else {
        title.trim().to_string()
    };
    let id = db.with(|conn| {
        conn.execute(
            "INSERT INTO table_doc
               (enterprise_id, title, kind, unit, scope, period_type, currency, sheet_json,
                mapping_json, macro_json, status, version, origin, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'CNY', ?7, ?8, '[]', 'draft', 1, ?9, '', ?10, ?10)",
            params![
                enterprise_id,
                title,
                kind,
                unit,
                scope,
                period_type,
                serde_json::to_string(&workbook).unwrap_or_else(|_| "{}".into()),
                serde_json::to_string(&mapping).unwrap_or_else(|_| "{}".into()),
                origin,
                now,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })?;
    Ok(json!({ "table_id": id, "title": title, "kind": kind, "sheets": ["Sheet1"] }))
}

/// 局部更新：传入的字段才改；sheet/mapping 变化时 version 自增
pub fn update(db: &Db, id: i64, body: &Value) -> Result<Value> {
    let Some(mut doc) = get(db, id)? else {
        return Ok(json!({ "error": format!("表格不存在: {id}") }));
    };
    let mut version_bump = false;

    if let Some(v) = body.get("title").and_then(|v| v.as_str()) {
        doc.title = v.to_string();
    }
    if let Some(v) = body.get("kind").and_then(|v| v.as_str()) {
        doc.kind = v.to_string();
    }
    for (key, target) in [
        ("unit", &mut doc.unit),
        ("scope", &mut doc.scope),
        ("period_type", &mut doc.period_type),
        ("currency", &mut doc.currency),
        ("note", &mut doc.note),
    ] {
        if let Some(v) = body.get(key).and_then(|v| v.as_str()) {
            *target = v.to_string();
        }
    }
    if let Some(v) = body.get("enterprise_id") {
        doc.enterprise_id = v.as_i64();
    }
    // 工作表切换（先把当前 sheet 写回再切）
    if let Some(key) = body.get("active").and_then(|v| v.as_str()) {
        doc.switch_sheet(key);
    }
    // 整簿替换（前端做页签增删改/透视插入时提交）
    if let Some(wb) = body.get("sheets").cloned() {
        if wb.is_array() {
            let normalized = normalize_workbook(&json!({
                "sheets": wb,
                "active": body.get("active").and_then(|v| v.as_str()).unwrap_or(""),
            }));
            doc.workbook = normalized;
            let key = doc.active_key();
            let sheet = sheet_of(&doc.workbook, &key);
            doc.sheet = json!({
                "columns": sheet.get("columns").cloned().unwrap_or(json!([])),
                "rows": sheet.get("rows").cloned().unwrap_or(json!([])),
                "meta": sheet.get("meta").cloned().unwrap_or(json!({})),
            });
            doc.mapping = sheet
                .get("mapping")
                .and_then(|v| v.as_object().cloned())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| auto_map(&doc.sheet));
            version_bump = true;
        }
    } else if let Some(sheet) = body.get("sheet") {
        if sheet.is_object() {
            doc.sheet = sheet.clone();
            version_bump = true;
        }
    }
    // 宏（整组保存）
    if let Some(macros) = body.get("macros") {
        if macros.is_array() {
            doc.macros = macros.clone();
        }
    }
    // 映射：显式给的优先；否则按行标题自动映射（用户改了标题也能跟上）
    match body.get("mapping") {
        Some(m) if m.is_object() => {
            doc.mapping = m.as_object().cloned().unwrap_or_default();
            version_bump = true;
        }
        _ if version_bump => {
            doc.mapping = auto_map(&doc.sheet);
        }
        _ => {}
    }
    doc.write_back();

    let now = now_db();
    let version = if version_bump { doc.version + 1 } else { doc.version };
    db.with(|conn| {
        conn.execute(
            "UPDATE table_doc SET enterprise_id = ?1, title = ?2, kind = ?3, unit = ?4, scope = ?5,
                    period_type = ?6, currency = ?7, sheet_json = ?8, mapping_json = ?9,
                    version = ?10, note = ?11, updated_at = ?12
             WHERE id = ?13",
            params![
                doc.enterprise_id,
                doc.title,
                doc.kind,
                doc.unit,
                doc.scope,
                doc.period_type,
                doc.currency,
                serde_json::to_string(&doc.workbook).unwrap_or_else(|_| "{}".into()),
                serde_json::to_string(&doc.mapping).unwrap_or_else(|_| "{}".into()),
                version,
                doc.note,
                now,
                id,
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({ "ok": true, "table_id": id, "version": version }))
}

/// 写入单元格：range = {row, col, values: [[..]]} 或单点 {row, col, value}
pub fn write_cells(db: &Db, id: i64, body: &Value) -> Result<Value> {
    let Some(mut doc) = get(db, id)? else {
        return Ok(json!({ "error": format!("表格不存在: {id}") }));
    };
    let source = body.get("source").and_then(|v| v.as_str()).unwrap_or("user");
    let confidence = body.get("confidence").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let mut written = 0usize;

    // 单点写入
    if let (Some(row), Some(col)) = (
        body.get("row").and_then(|v| v.as_str()),
        body.get("col").and_then(|v| v.as_str()),
    ) {
        if let Some(cell) = body.get("value") {
            set_cell(&mut doc.sheet, row, col, cell, source, confidence);
            written += 1;
        }
    }
    // 区域写入（二维数组，从 (row,col) 起，按行列顺序铺开）
    if let Some(values) = body.get("values").and_then(|v| v.as_array()) {
        let start_row = body.get("row").and_then(|v| v.as_str()).unwrap_or("");
        let start_col = body.get("col").and_then(|v| v.as_str()).unwrap_or("");
        let rows: Vec<String> = doc
            .sheet
            .get("rows")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|r| r.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string())
            .collect();
        let cols: Vec<String> = doc
            .sheet
            .get("columns")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|c| c.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string())
            .collect();
        let r0 = rows.iter().position(|k| k == start_row).unwrap_or(0);
        let c0 = cols.iter().position(|k| k == start_col).unwrap_or(0);
        for (dr, line) in values.iter().enumerate() {
            let Some(cells) = line.as_array() else { continue };
            for (dc, cell) in cells.iter().enumerate() {
                let (Some(rk), Some(ck)) = (rows.get(r0 + dr), cols.get(c0 + dc)) else { continue };
                set_cell(&mut doc.sheet, rk, ck, cell, source, confidence);
                written += 1;
            }
        }
    }
    // 单行写入：{row, cells: {col: value}}
    if let (Some(row), Some(cells)) = (
        body.get("row").and_then(|v| v.as_str()),
        body.get("cells").and_then(|v| v.as_object()),
    ) {
        for (col, value) in cells {
            set_cell(&mut doc.sheet, row, col, value, source, confidence);
            written += 1;
        }
    }

    if written == 0 {
        return Ok(json!({ "error": "没有可写入的单元格（需要 row/col/value 或 values 二维数组）" }));
    }
    // 重新自动映射，保证"改了科目名 → 映射跟上"
    doc.mapping = auto_map(&doc.sheet);
    doc.write_back();
    let now = now_db();
    let version = doc.version + 1;
    db.with(|conn| {
        conn.execute(
            "UPDATE table_doc SET sheet_json = ?1, mapping_json = ?2, version = ?3, updated_at = ?4,
                    status = CASE WHEN status = 'ingested' THEN 'confirmed' ELSE status END
             WHERE id = ?5",
            params![
                serde_json::to_string(&doc.workbook).unwrap_or_else(|_| "{}".into()),
                serde_json::to_string(&doc.mapping).unwrap_or_else(|_| "{}".into()),
                version,
                now,
                id,
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({ "ok": true, "table_id": id, "written": written, "version": version }))
}

fn set_cell(sheet: &mut Value, row_key: &str, col_key: &str, value: &Value, source: &str, confidence: f64) {
    let rows = match sheet.get_mut("rows").and_then(|v| v.as_array_mut()) {
        Some(r) => r,
        None => return,
    };
    for row in rows.iter_mut() {
        if row.get("key").and_then(|v| v.as_str()) != Some(row_key) {
            continue;
        }
        let cells = row
            .as_object_mut()
            .map(|o| o.entry("cells").or_insert_with(|| json!({})))
            .and_then(|c| c.as_object_mut());
        let Some(cells) = cells else { return };
        if value.is_null() {
            cells.remove(col_key);
            return;
        }
        let num = match value {
            Value::Number(n) => Some(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => s.trim().replace(',', "").parse::<f64>().ok(),
            _ => None,
        };
        cells.insert(
            col_key.to_string(),
            json!({
                "value": num.unwrap_or(0.0),
                "raw": value,
                "source": source,
                "confidence": confidence,
            }),
        );
        return;
    }
}

pub fn delete(db: &Db, id: i64) -> Result<Value> {
    let n = db.with(|conn| Ok(conn.execute("DELETE FROM table_doc WHERE id = ?1", [id])?))?;
    if n == 0 {
        return Ok(json!({ "error": format!("表格不存在: {id}") }));
    }
    Ok(json!({ "deleted": id }))
}

// ---------------------------------------------------------------------------
// 入库：TableDoc → finance（带来源标记，不覆盖公开信源）
// ---------------------------------------------------------------------------

/// 入库。默认**不覆盖公开信源数据**，只报告差异；`overwrite=true` 才强制覆盖。
pub fn ingest(db: &Db, id: i64, overwrite: bool) -> Result<Value> {
    let Some(doc) = get(db, id)? else {
        return Ok(json!({ "error": format!("表格不存在: {id}") }));
    };
    let Some(enterprise_id) = doc.enterprise_id else {
        return Ok(json!({ "error": "表格未绑定企业，无法入库" }));
    };
    let check = validate(&doc);
    if check["ok"] != json!(true) {
        return Ok(json!({
            "error": "勾稽校验未通过，已阻止入库",
            "validation": check,
        }));
    }

    let columns = doc.sheet.get("columns").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let factor = unit_factor(&doc.unit);
    let source_tag = format!(
        "用户提供（{} #{}）",
        if doc.origin == "manual" { "在线表格" } else { doc.origin.as_str() },
        doc.id
    );

    let mut created: Vec<Value> = Vec::new();
    let mut updated: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();

    for c in &columns {
        let col = c.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let period = c.get("period").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if period.is_empty() {
            continue;
        }
        let report_type = c
            .get("report_type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&doc.period_type)
            .to_string();

        // 组装 metrics（引擎口径：绝对额 _wan、比率原值）
        let mut metrics = Map::new();
        for (field, row) in doc.mapping.clone() {
            let Some(row_key) = row.as_str() else { continue };
            let Some(raw) = cell_value(&doc.sheet, row_key, col) else { continue };
            let value = if field.ends_with("_wan") { raw * factor } else { raw };
            metrics.insert(field, json!((value * 10_000.0).round() / 10_000.0));
        }
        if metrics.is_empty() {
            continue;
        }

        let existing: Option<(i64, String)> = db.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, source FROM finance WHERE enterprise_id = ?1 AND year = ?2 AND report_type = ?3",
                    params![enterprise_id, period, report_type],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?)
        })?;

        let num_of = |key: &str| metrics.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
        if let Some((row_id, existing_source)) = existing {
            let is_manual = existing_source.contains("用户提供");
            if !is_manual && !overwrite {
                // 公开信源数据：不覆盖，算出差异供前端提示
                let diff: Vec<Value> = ["revenue_wan", "net_profit_wan", "total_assets_wan", "total_liabilities_wan"]
                    .iter()
                    .filter_map(|k| {
                        let new_v = metrics.get(*k).and_then(|v| v.as_f64());
                        let old_v: Option<f64> = db
                            .with(|conn| {
                                let col = k.trim_end_matches("_wan");
                                let sql = format!("SELECT {col} FROM finance WHERE id = ?1");
                                Ok(conn.query_row(&sql, [row_id], |r| r.get::<_, f64>(0)).optional()?)
                            })
                            .ok()
                            .flatten();
                        match (old_v, new_v) {
                            (Some(o), Some(n)) if o != 0.0 && ((n - o) / o).abs() > 0.01 => Some(json!({
                                "field": k,
                                "public": o,
                                "manual": (n * 10_000.0).round() / 10_000.0,
                                "delta_pct": (((n - o) / o) * 10000.0).round() / 100.0,
                            })),
                            _ => None,
                        }
                    })
                    .collect();
                conflicts.push(json!({
                    "period": period, "report_type": report_type, "reason": "已有公开信源数据，默认不覆盖",
                    "public_source": existing_source, "diff": diff,
                }));
                skipped.push(json!({ "period": period, "report_type": report_type }));
                continue;
            }
            db.with(|conn| {
                conn.execute(
                    "UPDATE finance SET total_assets = ?1, total_liabilities = ?2, revenue = ?3,
                            net_profit = ?4, debt_ratio = ?5, source = ?6, metrics_json = ?7
                     WHERE id = ?8",
                    params![
                        num_of("total_assets_wan"),
                        num_of("total_liabilities_wan"),
                        num_of("revenue_wan"),
                        num_of("net_profit_wan"),
                        num_of("debt_ratio"),
                        source_tag,
                        serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".into()),
                        row_id,
                    ],
                )?;
                Ok(())
            })?;
            updated.push(json!({ "period": period, "report_type": report_type }));
        } else {
            db.with(|conn| {
                conn.execute(
                    "INSERT INTO finance
                       (enterprise_id, year, report_type, total_assets, total_liabilities, revenue,
                        net_profit, debt_ratio, source, metrics_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        enterprise_id,
                        period,
                        report_type,
                        num_of("total_assets_wan"),
                        num_of("total_liabilities_wan"),
                        num_of("revenue_wan"),
                        num_of("net_profit_wan"),
                        num_of("debt_ratio"),
                        source_tag,
                        serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".into()),
                    ],
                )?;
                Ok(())
            })?;
            created.push(json!({ "period": period, "report_type": report_type }));
        }
    }

    // 数据状态：finance 标记为 manual（区别于公开信源的 ok），让评分/报告如实标注来源
    let mut status: Map<String, Value> = db
        .with(|conn| {
            let raw: String = conn
                .query_row("SELECT data_status_json FROM enterprise WHERE id = ?1", [enterprise_id], |r| r.get(0))
                .unwrap_or_else(|_| "{}".into());
            Ok(serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default())
        })
        .unwrap_or_default();
    if !created.is_empty() || !updated.is_empty() {
        status.insert("finance".into(), json!("manual"));
    }
    let now = now_db();
    db.with(|conn| {
        conn.execute(
            "UPDATE enterprise SET data_status_json = ?1 WHERE id = ?2",
            params![Value::Object(status).to_string(), enterprise_id],
        )?;
        conn.execute(
            "UPDATE table_doc SET status = 'ingested', updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    })?;

    // 入库后触发预警闭环（失败不影响入库结果）
    let alerts = crate::services::alerts::generate_for_enterprise(db, enterprise_id, "manual_table")
        .unwrap_or_else(|e| json!({ "error": e.to_string() }));

    Ok(json!({
        "ok": true,
        "table_id": id,
        "enterprise_id": enterprise_id,
        "unit": doc.unit,
        "scope": doc.scope,
        "source": source_tag,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "conflicts": conflicts,
        "alerts": alerts.get("created").cloned().unwrap_or(json!([])),
        "validation": check,
    }))
}

/// 确认视觉识别单元格：source vision → user，confidence → 1.0
/// （视觉读数默认视为「待确认」，确认前不允许入库 —— 财报数字读错一个小数点就全盘皆错）
pub fn confirm_cells(db: &Db, id: i64, cells: &[Value]) -> Result<Value> {
    let Some(mut doc) = get(db, id)? else {
        return Ok(json!({ "error": format!("表格不存在: {id}") }));
    };
    let targets: Vec<(String, String)> = if cells.is_empty() {
        // 全部待确认
        let mut list = Vec::new();
        for r in doc.sheet.get("rows").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            let row_key = r.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
            for (col, cell) in r.get("cells").and_then(|v| v.as_object()).cloned().unwrap_or_default() {
                if cell.get("source").and_then(|v| v.as_str()) == Some("vision") {
                    list.push((row_key.clone(), col));
                }
            }
        }
        list
    } else {
        cells
            .iter()
            .filter_map(|c| {
                Some((
                    c.get("row").and_then(|v| v.as_str())?.to_string(),
                    c.get("col").and_then(|v| v.as_str())?.to_string(),
                ))
            })
            .collect()
    };

    let mut confirmed = 0usize;
    for (row_key, col_key) in &targets {
        if let Some(rows) = doc.sheet.get_mut("rows").and_then(|v| v.as_array_mut()) {
            for row in rows.iter_mut() {
                if row.get("key").and_then(|v| v.as_str()) != Some(row_key.as_str()) {
                    continue;
                }
                if let Some(cell) = row
                    .get_mut("cells")
                    .and_then(|c| c.get_mut(col_key))
                    .and_then(|c| c.as_object_mut())
                {
                    cell.insert("source".into(), json!("user"));
                    cell.insert("confidence".into(), json!(1.0));
                    cell.insert("confirmed_at".into(), json!(now_db()));
                    confirmed += 1;
                }
            }
        }
    }

    let now = now_db();
    doc.write_back();
    db.with(|conn| {
        conn.execute(
            "UPDATE table_doc SET sheet_json = ?1, status = CASE WHEN status = 'draft' THEN 'confirmed' ELSE status END,
                    updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&doc.workbook).unwrap_or_else(|_| "{}".into()),
                now,
                id,
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({ "ok": true, "table_id": id, "confirmed": confirmed }))
}

/// 入库前差异预览（不写库）：展示将新增/更新/冲突的期间
pub fn preview_ingest(db: &Db, id: i64) -> Result<Value> {
    let Some(doc) = get(db, id)? else {
        return Ok(json!({ "error": format!("表格不存在: {id}") }));
    };
    let Some(enterprise_id) = doc.enterprise_id else {
        return Ok(json!({ "error": "表格未绑定企业" }));
    };
    let columns = doc.sheet.get("columns").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut plan: Vec<Value> = Vec::new();
    for c in &columns {
        let period = c.get("period").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if period.is_empty() {
            continue;
        }
        let report_type = c
            .get("report_type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&doc.period_type);
        let existing: Option<String> = db.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT source FROM finance WHERE enterprise_id = ?1 AND year = ?2 AND report_type = ?3",
                    params![enterprise_id, period, report_type],
                    |r| r.get(0),
                )
                .optional()?)
        })?;
        let action = match existing.as_deref() {
            None => "create",
            Some(s) if s.contains("用户提供") => "update",
            Some(_) => "conflict",
        };
        plan.push(json!({
            "period": period, "report_type": report_type, "action": action,
            "existing_source": existing,
        }));
    }
    Ok(json!({
        "table_id": id,
        "enterprise_id": enterprise_id,
        "unit": doc.unit,
        "plan": plan,
        "validation": validate(&doc),
    }))
}

/// 模板清单（前端"新建表格"用）
pub fn templates() -> Value {
    let items: Vec<Value> = TEMPLATES
        .iter()
        .map(|(kind, title, rows)| {
            json!({
                "kind": kind,
                "title": title,
                "rows": rows.iter().map(|k| {
                    json!({ "field": k, "label": field_meta(k).map(|f| f.label).unwrap_or(k) })
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    let fields: Vec<Value> = FIELDS
        .iter()
        .map(|f| json!({ "key": f.key, "label": f.label, "kind": f.kind, "unit": f.unit, "aliases": f.aliases }))
        .collect();
    json!({ "templates": items, "fields": fields })
}

/// 供工具/前端复用：把一份"科目 → 值"的行集合转换过来
/// （R3 的图片识别 / 粘贴读取层会调用它把 Reading 填进表格）
#[allow(dead_code)]
pub fn rows_from_pairs(pairs: &BTreeMap<String, f64>) -> Value {
    let rows: Vec<Value> = pairs
        .iter()
        .enumerate()
        .map(|(i, (label, value))| {
            let field = match_field(label).unwrap_or("");
            json!({
                "key": format!("r{}", i + 1),
                "label": label,
                "field": field,
                "cells": { "c1": { "value": value, "source": "vision", "confidence": 0.8 } },
            })
        })
        .collect();
    json!({ "columns": [], "rows": rows, "meta": {} })
}

/// 表内数值汇总（对话里快速回答"这张表里营收多少"）
pub fn summary(db: &Db, doc: &TableDoc) -> Value {
    let columns = doc.sheet.get("columns").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut periods: Vec<Value> = Vec::new();
    for c in &columns {
        let col = c.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let get = |field: &str| -> Option<f64> {
            doc.mapping
                .get(field)
                .and_then(|v| v.as_str())
                .and_then(|row| cell_value(&doc.sheet, row, col))
        };
        periods.push(json!({
            "period": c.get("period"),
            "report_type": c.get("report_type"),
            "revenue_wan": get("revenue_wan"),
            "net_profit_wan": get("net_profit_wan"),
            "total_assets_wan": get("total_assets_wan"),
            "total_liabilities_wan": get("total_liabilities_wan"),
            "debt_ratio": get("debt_ratio"),
        }));
    }
    let enterprise: Option<String> = doc.enterprise_id.and_then(|eid| {
        db.with(|conn| {
            Ok(conn
                .query_row("SELECT name FROM enterprise WHERE id = ?1", [eid], |r| r.get(0))
                .optional()?)
        })
        .unwrap_or(None)
    });
    json!({
        "table_id": doc.id,
        "title": doc.title,
        "kind": doc.kind,
        "unit": doc.unit,
        "scope": doc.scope,
        "status": doc.status,
        "enterprise_id": doc.enterprise_id,
        "enterprise": enterprise,
        "mapped_fields": doc.mapping.keys().cloned().collect::<Vec<_>>(),
        "periods": periods,
    })
}

/// 供工具使用：按 id 取表并返回汇总
pub fn summary_by_id(db: &Db, id: i64) -> Result<Value> {
    let doc = get(db, id)?.ok_or_else(|| anyhow!("表格不存在: {id}"))?;
    Ok(summary(db, &doc))
}

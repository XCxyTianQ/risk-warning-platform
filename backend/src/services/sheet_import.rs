//! 表格「读取」的确定性入口：CSV / XLSX / TSV 文本 → 归一化网格 → TableDoc。
//!
//! 与视觉读取的区别：
//!  * **确定性**：不经过模型，零幻觉、零 token，单元格直接标 `source=file`、confidence=1.0，
//!    因此不需要人工确认即可入库；
//!  * 视觉读取（`services::reading`）用于截图/照片，产出的是「待确认」单元格。
//!
//! 识别策略（尽量贴合真实财报表格）：
//!  1. 读出二维网格（字符串）；
//!  2. 找表头行：第一个「非空单元格数 ≥ 2 且含年份或科目关键词」的行；
//!  3. 判断方向：
//!     - **宽表**（列是期间）：表头行里出现 2 个以上年份/报告期 → 列 → 期间；
//!     - **长表**（行是期间）：存在「年度/年份/期间」列 + 「科目」列 + 「数值」列 → 透视；
//!  4. 行标签走科目别名词典（`tables::match_field`）得到 engine field；
//!  5. 顺带识别表头里的单位与口径（万元/元/亿元、合并报表/母公司）。

use anyhow::{anyhow, Result};
use calamine::{Data, Reader};
use serde_json::{json, Map, Value};

use crate::db::Db;
use crate::services::tables;

/// 二维网格（全部转成字符串，空为 ""）
pub type Grid = Vec<Vec<String>>;

fn cell_to_string(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => {
            if (*f - f.round()).abs() < 1e-9 {
                format!("{}", f.round() as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e:?}"),
    }
}

/// 解析 xlsx / xls / ods
pub fn parse_workbook(bytes: &[u8]) -> Result<Grid> {
    use std::io::Cursor;
    let cursor = Cursor::new(bytes.to_vec());
    let mut book = calamine::open_workbook_auto_from_rs(cursor)
        .map_err(|e| anyhow!("打开表格失败：{e}"))?;
    let names = book.sheet_names().to_vec();
    let Some(first) = names.first() else {
        return Err(anyhow!("工作簿里没有工作表"));
    };
    let range = book
        .worksheet_range(first)
        .map_err(|e| anyhow!("读取工作表「{first}」失败：{e}"))?;
    let mut grid: Grid = Vec::new();
    for row in range.rows() {
        grid.push(row.iter().map(cell_to_string).collect());
    }
    Ok(grid)
}

/// 解析 CSV / TSV 文本（按分隔符自动判断）
pub fn parse_delimited(text: &str) -> Grid {
    let head = text.lines().next().unwrap_or("");
    let delim = if head.matches('\t').count() > head.matches(',').count() {
        '\t'
    } else {
        ','
    };
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| split_line(line, delim))
        .collect()
}

fn split_line(line: &str, delim: char) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == delim {
            out.push(cur.trim().to_string());
            cur = String::new();
        } else {
            cur.push(c);
        }
    }
    out.push(cur.trim().to_string());
    out
}

/// 从网格抽取单位/口径/报告期线索
pub fn detect_meta(grid: &Grid) -> Value {
    let mut unit = "";
    let mut scope = "";
    for row in grid.iter().take(6) {
        for cell in row {
            if unit.is_empty() && (cell.contains("万元") || cell.contains("亿元") || cell == "元") {
                unit = if cell.contains("亿元") {
                    "亿元"
                } else if cell.contains("万元") {
                    "万元"
                } else {
                    "元"
                };
            }
            if scope.is_empty() && (cell.contains("合并") || cell.contains("母公司")) {
                scope = if cell.contains("母公司") { "母公司" } else { "合并报表" };
            }
        }
    }
    json!({ "unit": unit, "scope": scope })
}

fn looks_like_period(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 4 {
        return false;
    }
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return false;
    }
    let year: i32 = digits[..4].parse().unwrap_or(0);
    (1990..2100).contains(&year)
}

fn period_of(s: &str) -> String {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.chars().take(4).collect()
}

/// 网格 → TableDoc 的字段：{kind, columns:[{period,report_type}], rows:[{label,field,cells}]}
pub struct Extracted {
    pub columns: Vec<(String, String)>,
    pub rows: Vec<(String, String, Vec<Option<f64>>)>, // (label, field, 每列的值)
    pub header_row: usize,
    pub direction: &'static str,
}

fn to_number(s: &str) -> Option<f64> {
    let t = s.trim().replace(',', "").replace('，', "").replace('％', "%");
    if t.is_empty() || t == "-" || t == "—" || t == "--" {
        return None;
    }
    let t = t.trim_end_matches('%').trim();
    let t = t.trim_start_matches('¥').trim_start_matches('￥').trim();
    // 括号表示负数：（1,234） → -1234
    if let Some(inner) = t.strip_prefix('(').and_then(|x| x.strip_suffix(')')) {
        return inner.replace(',', "").parse::<f64>().ok().map(|v| -v);
    }
    t.parse::<f64>().ok()
}

/// 识别宽表（列=期间）
fn try_wide(grid: &Grid) -> Option<Extracted> {
    for (hr, row) in grid.iter().enumerate().take(8) {
        let periods: Vec<(usize, String)> = row
            .iter()
            .enumerate()
            .filter(|(_, c)| looks_like_period(c))
            .map(|(i, c)| (i, period_of(c)))
            .collect();
        if periods.len() < 1 {
            continue;
        }
        // 至少还有一列是科目名（左侧）
        let label_col = (0..periods[0].0).find(|i| {
            grid.iter()
                .skip(hr + 1)
                .take(12)
                .any(|r| r.get(*i).map(|c| !c.trim().is_empty()).unwrap_or(false))
        })?;

        let mut rows: Vec<(String, String, Vec<Option<f64>>)> = Vec::new();
        for r in grid.iter().skip(hr + 1) {
            let label = r.get(label_col).cloned().unwrap_or_default();
            if label.trim().is_empty() {
                continue;
            }
            let values: Vec<Option<f64>> = periods
                .iter()
                .map(|(i, _)| r.get(*i).and_then(|c| to_number(c)))
                .collect();
            if values.iter().all(|v| v.is_none()) {
                continue; // 小计/空行
            }
            let field = tables::match_field(&label).unwrap_or("").to_string();
            rows.push((label, field, values));
        }
        if rows.is_empty() {
            continue;
        }
        let columns: Vec<(String, String)> = periods
            .iter()
            .map(|(_, p)| {
                let header = row.iter().find(|c| period_of(c) == *p).cloned().unwrap_or_default();
                let rt = if header.contains('中') || header.contains("半年") {
                    "中报"
                } else if header.contains('季') {
                    "季报"
                } else {
                    "年报"
                };
                (p.clone(), rt.to_string())
            })
            .collect();
        return Some(Extracted { columns, rows, header_row: hr, direction: "wide" });
    }
    None
}

/// 识别长表（行=期间，列含「年度/科目/数值」）
fn try_long(grid: &Grid) -> Option<Extracted> {
    let hr = grid.iter().position(|r| r.iter().filter(|c| !c.trim().is_empty()).count() >= 2)?;
    let header = &grid[hr];
    let find_col = |keys: &[&str]| -> Option<usize> {
        header.iter().position(|c| {
            let t = c.trim();
            keys.iter().any(|k| t == *k || t.contains(k))
        })
    };
    let period_col = find_col(&["年度", "年份", "期间", "报告期", "year"])?;
    let label_col = find_col(&["科目", "项目", "指标", "名称", "item"])?;
    let value_col = find_col(&["数值", "金额", "值", "value"])?;

    let mut by_period: Vec<(String, Vec<(String, Option<f64>)>)> = Vec::new();
    for r in grid.iter().skip(hr + 1) {
        let period = r.get(period_col).cloned().unwrap_or_default();
        let label = r.get(label_col).cloned().unwrap_or_default();
        let value = r.get(value_col).and_then(|c| to_number(c));
        if period.trim().is_empty() || label.trim().is_empty() {
            continue;
        }
        let p = period_of(&period);
        match by_period.iter_mut().find(|(k, _)| *k == p) {
            Some((_, list)) => list.push((label, value)),
            None => by_period.push((p, vec![(label, value)])),
        }
    }
    if by_period.is_empty() {
        return None;
    }
    // 透视成宽表
    let mut labels: Vec<String> = Vec::new();
    for (_, list) in &by_period {
        for (l, _) in list {
            if !labels.contains(l) {
                labels.push(l.clone());
            }
        }
    }
    let columns: Vec<(String, String)> =
        by_period.iter().map(|(p, _)| (p.clone(), "年报".to_string())).collect();
    let rows: Vec<(String, String, Vec<Option<f64>>)> = labels
        .iter()
        .map(|label| {
            let values: Vec<Option<f64>> = by_period
                .iter()
                .map(|(_, list)| list.iter().find(|(l, _)| l == label).and_then(|(_, v)| *v))
                .collect();
            let field = tables::match_field(label).unwrap_or("").to_string();
            (label.clone(), field, values)
        })
        .filter(|(_, _, values)| values.iter().any(|v| v.is_some()))
        .collect();
    Some(Extracted { columns, rows, header_row: hr, direction: "long" })
}

/// 网格 → 抽取结果（先宽表后长表）
pub fn extract(grid: &Grid) -> Result<Extracted> {
    if grid.is_empty() {
        return Err(anyhow!("表格内容为空"));
    }
    try_wide(grid)
        .or_else(|| try_long(grid))
        .ok_or_else(|| anyhow!("未能识别表格结构（需要表头含年份，或含「年度/科目/数值」三列）"))
}

/// 抽取结果 → TableDoc（新建表格并写入单元格）
#[allow(clippy::too_many_arguments)]
pub fn build_table(
    db: &Db,
    ext: &Extracted,
    enterprise_id: Option<i64>,
    title: &str,
    unit: &str,
    scope: &str,
) -> Result<Value> {
    let created = tables::create(
        db,
        enterprise_id,
        title,
        "kpi",
        &ext.columns,
        unit,
        scope,
        "年报",
        "file",
    )?;
    let table_id = created
        .get("table_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| anyhow!("建表失败"))?;
    let Some(doc) = tables::get(db, table_id)? else {
        return Err(anyhow!("建表后读取失败"));
    };

    // 用抽取到的科目行替换模板行（保留列），命中的走映射
    let mut sheet = doc.sheet.clone();
    let col_keys: Vec<String> = doc
        .sheet
        .get("columns")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|c| c.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string())
        .collect();

    let mut rows: Vec<Value> = Vec::new();
    let mut mapping = Map::new();
    for (i, (label, field, values)) in ext.rows.iter().enumerate() {
        let key = format!("r{}", i + 1);
        let mut cells = Map::new();
        for (ci, value) in values.iter().enumerate() {
            let Some(col) = col_keys.get(ci) else { continue };
            let Some(v) = value else { continue };
            cells.insert(
                col.clone(),
                json!({ "value": v, "source": "file", "confidence": 1.0 }),
            );
        }
        if !field.is_empty() {
            mapping.entry(field.clone()).or_insert(json!(key));
        }
        rows.push(json!({
            "key": key,
            "label": label,
            "field": field,
            "cells": Value::Object(cells),
        }));
    }
    sheet["rows"] = Value::Array(rows);

    tables::update(db, table_id, &json!({ "sheet": sheet, "mapping": mapping }))?;

    let mapped = mapping.len();
    Ok(json!({
        "ok": true,
        "table_id": table_id,
        "title": title,
        "direction": ext.direction,
        "header_row": ext.header_row,
        "columns": ext.columns.iter().map(|(p, rt)| format!("{p}{rt}")).collect::<Vec<_>>(),
        "rows": ext.rows.len(),
        "mapped_fields": mapped,
        "unmapped": ext.rows.iter().filter(|(_, f, _)| f.is_empty()).map(|(l, _, _)| l.clone()).collect::<Vec<_>>(),
        "note": "确定性解析：单元格标记为 source=file（可信度 1.0），无需人工确认即可入库",
    }))
}

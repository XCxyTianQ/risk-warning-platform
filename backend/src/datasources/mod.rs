//! 数据源层：公开信源直连（不依赖 akshare/pandas）。
//!
//! 与 Python 版 `app/datasources/` 对齐的维度与优先级：
//!   finance: 新浪关键指标(gjzb) + 新浪三表(fzb/lrb/llb) —— 字段级合并
//!   news:    东方财富个股新闻
//!   legal:   巨潮资讯公司诉讼统计
//!
//! 另提供 A 股代码-名称对照（东财全市场快照，单次请求覆盖全部代码）。

pub mod cninfo;
pub mod eastmoney;
pub mod http;
pub mod sina;

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::db::Db;

// ---------------------------------------------------------------------------
// 规范记录
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct FinanceRecord {
    pub year: String,
    pub report_type: String,
    pub revenue: f64,
    pub net_profit: f64,
    pub debt_ratio: f64,
    pub total_assets: f64,
    pub total_liabilities: f64,
    pub source: String,
    pub metrics: Map<String, Value>,
}

#[derive(Debug, Clone, Default)]
pub struct NewsRecord {
    pub title: String,
    pub content: String,
    pub source: String,
    pub url: String,
    pub published_at: String,
    pub sentiment: String,
}

#[derive(Debug, Clone, Default)]
pub struct LegalRecord {
    pub case_no: String,
    pub doc_type: String,
    pub title: String,
    pub court: String,
    pub cause: String,
    pub amount: f64,
    pub status: String,
    pub judgment_date: String,
    pub source: String,
}

#[derive(Debug, Default)]
pub struct FetchResult {
    #[allow(dead_code)]
    pub dimension: String,
    pub source: String,
    pub finance: Vec<FinanceRecord>,
    pub news: Vec<NewsRecord>,
    pub legal: Vec<LegalRecord>,
    pub gap: Option<String>,
    pub error: Option<String>,
}

impl FetchResult {
    pub fn ok(&self) -> bool {
        self.error.is_none()
    }

    pub fn total(&self) -> usize {
        self.finance.len() + self.news.len() + self.legal.len()
    }

    pub fn empty(dimension: &str, source: &str, error: impl Into<String>) -> Self {
        Self {
            dimension: dimension.into(),
            source: source.into(),
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/// 情感分类（关键词规则，与 Python 版 `classify_sentiment` 同一套词表）
pub fn classify_sentiment(text: &str) -> &'static str {
    const NEGATIVE: [&str; 28] = [
        "处罚", "罚款", "立案", "调查", "问询", "警示", "违规", "违法", "诉讼", "起诉",
        "被执行", "失信", "冻结", "退市", "亏损", "下滑", "减持", "质押", "风险提示",
        "欠款", "违约", "停牌", "暴跌", "质疑", "争议", "限制", "解禁", "商誉减值",
    ];
    const POSITIVE: [&str; 19] = [
        "增长", "盈利", "中标", "获奖", "增持", "回购", "分红", "突破", "合作", "签约",
        "创新高", "上调", "利好", "获得", "通过", "入选", "领先", "投产", "扩产",
    ];
    let neg = NEGATIVE.iter().filter(|w| text.contains(**w)).count();
    let pos = POSITIVE.iter().filter(|w| text.contains(**w)).count();
    if neg > pos {
        "negative"
    } else if pos > neg {
        "positive"
    } else {
        "neutral"
    }
}

/// 新浪接口需要 sh/sz/bj 前缀
pub fn market_prefix(code: &str) -> String {
    if code.starts_with('6') || code.starts_with('9') {
        format!("sh{code}")
    } else if code.starts_with('0') || code.starts_with('3') || code.starts_with('2') {
        format!("sz{code}")
    } else {
        format!("bj{code}")
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 解析新浪返回里某一指标的值（同名指标可能重复出现）
pub fn item_value(items: &[Value], title: &str) -> Option<f64> {
    for it in items {
        if it.get("item_title").and_then(|v| v.as_str()) == Some(title) {
            if let Some(v) = num(it.get("item_value")) {
                return Some(v);
            }
        }
    }
    None
}

/// 财务指标映射：(metrics_json 键, 指标名, 单位)  unit: wan=元→万元 / ratio=百分比原值 / num=原值
pub const FINANCE_METRICS: &[(&str, &str, &str)] = &[
    ("revenue_wan", "营业总收入", "wan"),
    ("net_profit_wan", "归母净利润", "wan"),
    ("net_profit_total_wan", "净利润", "wan"),
    ("operating_cost_wan", "营业成本", "wan"),
    ("deducted_profit_wan", "扣非净利润", "wan"),
    ("equity_wan", "股东权益合计(净资产)", "wan"),
    ("goodwill_wan", "商誉", "wan"),
    ("ocf_wan", "经营现金流量净额", "wan"),
    ("eps", "基本每股收益", "num"),
    ("bvps", "每股净资产", "num"),
    ("ocfps", "每股经营现金流", "num"),
    ("undistributed_ps", "每股未分配利润", "num"),
    ("surplus_reserve_ps", "每股盈余公积金", "num"),
    ("retained_ps", "每股留存收益", "num"),
    ("revenue_ps", "每股营业总收入", "num"),
    ("ebit_ps", "每股息税前利润", "num"),
    ("roe", "净资产收益率(ROE)", "ratio"),
    ("roa", "总资产报酬率(ROA)", "ratio"),
    ("gross_margin", "毛利率", "ratio"),
    ("net_margin", "销售净利率", "ratio"),
    ("period_expense_ratio", "期间费用率", "ratio"),
    ("debt_ratio", "资产负债率", "ratio"),
    ("ebit_margin", "息税前利润率", "ratio"),
    ("operating_margin", "营业利润率", "ratio"),
    ("roic", "投入资本回报率", "ratio"),
    ("revenue_growth", "营业总收入增长率", "ratio"),
    ("profit_growth", "归属母公司净利润增长率", "ratio"),
    ("ocf_to_revenue", "经营活动净现金/销售收入", "num"),
    ("ocf_to_profit", "经营活动净现金/归属母公司的净利润", "num"),
    ("tax_to_pretax", "所得税/利润总额", "ratio"),
    ("current_ratio", "流动比率", "num"),
    ("quick_ratio", "速动比率", "num"),
    ("equity_multiplier", "权益乘数", "num"),
    ("debt_to_equity", "产权比率", "ratio"),
    ("cash_ratio", "现金比率", "num"),
    ("ar_turnover", "应收账款周转率", "num"),
    ("ar_days", "应收账款周转天数", "num"),
    ("inventory_turnover", "存货周转率", "num"),
    ("inventory_days", "存货周转天数", "num"),
    ("asset_turnover", "总资产周转率", "num"),
    ("asset_days", "总资产周转天数", "num"),
    ("current_asset_turnover", "流动资产周转率", "num"),
    ("ap_turnover", "应付账款周转率", "num"),
];

/// 三表科目映射：(metrics_json 键, 科目名)
pub const BALANCE_ITEMS: &[(&str, &str)] = &[
    ("current_assets_wan", "流动资产合计"),
    ("current_liabilities_wan", "流动负债合计"),
    ("accounts_receivable_wan", "应收账款"),
    ("inventory_wan", "存货"),
    ("goodwill_wan", "商誉"),
    ("fixed_assets_wan", "固定资产净额"),
    ("fixed_assets_gross_wan", "固定资产原值"),
    ("accum_depreciation_wan", "累计折旧"),
    ("surplus_reserve_wan", "盈余公积"),
    ("undistributed_profit_wan", "未分配利润"),
    ("equity_parent_wan", "归属于母公司股东权益合计"),
    ("total_assets_wan", "资产总计"),
    ("total_liabilities_wan", "负债合计"),
];

pub const INCOME_ITEMS: &[(&str, &str)] = &[
    ("revenue_wan", "营业总收入"),
    ("operating_cost_wan", "营业成本"),
    ("operating_profit_wan", "营业利润"),
    ("total_profit_wan", "利润总额"),
    ("income_tax_wan", "所得税费用"),
    ("net_profit_total_wan", "净利润"),
    ("net_profit_wan", "归属于母公司所有者的净利润"),
    ("finance_expense_wan", "财务费用"),
    ("selling_expense_wan", "销售费用"),
    ("admin_expense_wan", "管理费用"),
    ("rd_expense_wan", "研发费用"),
];

pub const CASHFLOW_ITEMS: &[(&str, &str)] = &[
    ("ocf_wan", "经营活动产生的现金流量净额"),
    ("capex_wan", "购建固定资产、无形资产和其他长期资产所支付的现金"),
];

// ---------------------------------------------------------------------------
// 代码-名称对照（东财全市场快照；进程内缓存 30 分钟）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct CodeCache {
    map: BTreeMap<String, String>,
    ts: f64,
    inflight: bool,
}

static CODE_CACHE: Mutex<Option<CodeCache>> = Mutex::new(None);

fn cache() -> std::sync::MutexGuard<'static, Option<CodeCache>> {
    CODE_CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 按代码取证券简称（命中缓存；未命中返回空串）
pub fn name_of(code: &str) -> String {
    let guard = cache();
    guard
        .as_ref()
        .and_then(|c| c.map.get(code).cloned())
        .unwrap_or_default()
}

/// 按需解析：代码 → 简称（结果写入进程内缓存；避免批量拉全市场被限流）
pub async fn name_of_async(code: &str) -> String {
    if let Some(cached) = {
        let guard = cache();
        guard.as_ref().and_then(|c| c.map.get(code).cloned())
    } {
        return cached;
    }
    match eastmoney::fetch_stock_name(code).await {
        Ok(name) => {
            let mut guard = cache();
            guard
                .get_or_insert_with(CodeCache::default)
                .map
                .insert(code.to_string(), name.clone());
            name
        }
        Err(_) => String::new(),
    }
}

/// 关键词 → 候选（代码走单只查询；名称走东财搜索建议；结果进缓存）
pub async fn resolve_code_async(query: &str, limit: usize) -> Vec<(String, String)> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    if let Some(code) = crate::util::normalize_code(q) {
        let name = name_of_async(&code).await;
        return if name.is_empty() { vec![] } else { vec![(code, name)] };
    }
    if let Ok(hits) = eastmoney::suggest(q, limit).await {
        if !hits.is_empty() {
            let mut guard = cache();
            let entry = guard.get_or_insert_with(CodeCache::default);
            for (code, name) in &hits {
                entry.map.insert(code.clone(), name.clone());
            }
            return hits;
        }
    }
    resolve_code(q, limit)
}

/// 严格解析（新建企业用）：代码，或完全相等 / 长度 ≥4 的前缀匹配
pub async fn resolve_code_strict_async(query: &str) -> Option<(String, String)> {
    let q = query.trim();
    if let Some(code) = crate::util::normalize_code(q) {
        let name = name_of_async(&code).await;
        return if name.is_empty() { None } else { Some((code, name)) };
    }
    let hits = resolve_code_async(q, 8).await;
    if let Some(hit) = hits.iter().find(|(_, name)| name == q) {
        return Some(hit.clone());
    }
    if q.chars().count() >= 4 {
        if let Some(hit) = hits.iter().find(|(_, name)| name.starts_with(q)) {
            return Some(hit.clone());
        }
    }
    if hits.is_empty() {
        return resolve_code_strict(q);
    }
    hits.first().cloned()
}

/// 确保代码表已加载（超过 TTL 或为空时重新拉取）
pub async fn ensure_code_table(force: bool) -> Result<usize> {
    let stale = {
        let guard = cache();
        match guard.as_ref() {
            Some(c) if !force && !c.map.is_empty() && (now_secs() - c.ts) < 1800.0 => false,
            _ => true,
        }
    };
    if !stale {
        let guard = cache();
        return Ok(guard.as_ref().map(|c| c.map.len()).unwrap_or(0));
    }
    {
        let mut guard = cache();
        let entry = guard.get_or_insert_with(CodeCache::default);
        if entry.inflight {
            return Ok(entry.map.len());
        }
        entry.inflight = true;
    }
    let result = eastmoney::fetch_code_table().await;
    let mut guard = cache();
    let entry = guard.get_or_insert_with(CodeCache::default);
    entry.inflight = false;
    match result {
        Ok(map) => {
            let n = map.len();
            entry.map = map;
            entry.ts = now_secs();
            Ok(n)
        }
        Err(err) => Err(err),
    }
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 名称 → (code, name) 严格解析：完全相等或长度 ≥4 的前缀匹配
pub fn resolve_code_strict(query: &str) -> Option<(String, String)> {
    let q = query.trim();
    let guard = cache();
    let c = guard.as_ref()?;
    if c.map.is_empty() {
        return None;
    }
    if let Some((code, name)) = c.map.iter().find(|(_, n)| n.as_str() == q) {
        return Some((code.clone(), name.clone()));
    }
    if q.chars().count() >= 4 {
        if let Some((code, name)) = c.map.iter().find(|(_, n)| n.starts_with(q)) {
            return Some((code.clone(), name.clone()));
        }
    }
    None
}

/// 名称 → 候选列表（模糊包含，最多 limit 条）
pub fn resolve_code(query: &str, limit: usize) -> Vec<(String, String)> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    let guard = cache();
    let Some(c) = guard.as_ref() else { return vec![] };
    let mut hits: Vec<(String, String)> = c
        .map
        .iter()
        .filter(|(_, n)| n.contains(q))
        .map(|(code, name)| (code.clone(), name.clone()))
        .collect();
    hits.sort_by_key(|(_, name)| {
        let rank = if name == q {
            0
        } else if name.starts_with(q) {
            1
        } else {
            2
        };
        (rank, name.chars().count())
    });
    hits.truncate(limit);
    hits
}

// ---------------------------------------------------------------------------
// 入 库
// ---------------------------------------------------------------------------

fn load_json_map(raw: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 幂等入库：财务按 (企业, 年份, 报告类型) 合并指标；新闻/法律按标题去重
pub fn upsert_records(db: &Db, enterprise_id: i64, result: &FetchResult) -> Result<(i64, i64)> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut inserted = 0i64;
        let mut updated = 0i64;

        for rec in &result.finance {
            let existing: Option<(i64, String, String)> = tx
                .query_row(
                    "SELECT id, metrics_json, source FROM finance
                     WHERE enterprise_id = ?1 AND year = ?2 AND report_type = ?3",
                    rusqlite::params![enterprise_id, rec.year, rec.report_type],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            let metrics = serde_json::to_string(&rec.metrics).unwrap_or_else(|_| "{}".into());
            match existing {
                Some((id, old_metrics, old_source)) => {
                    let mut merged = load_json_map(&old_metrics);
                    for (k, v) in rec.metrics.clone() {
                        merged.insert(k, v);
                    }
                    let merged_text = serde_json::to_string(&Value::Object(merged)).unwrap_or_default();
                    let source = merge_source(&old_source, &rec.source);
                    tx.execute(
                        "UPDATE finance SET
                           revenue = CASE WHEN ?1 != 0 THEN ?1 ELSE revenue END,
                           net_profit = CASE WHEN ?2 != 0 THEN ?2 ELSE net_profit END,
                           debt_ratio = CASE WHEN ?3 != 0 THEN ?3 ELSE debt_ratio END,
                           total_assets = CASE WHEN ?4 != 0 THEN ?4 ELSE total_assets END,
                           total_liabilities = CASE WHEN ?5 != 0 THEN ?5 ELSE total_liabilities END,
                           metrics_json = ?6, source = ?7
                         WHERE id = ?8",
                        rusqlite::params![
                            rec.revenue,
                            rec.net_profit,
                            rec.debt_ratio,
                            rec.total_assets,
                            rec.total_liabilities,
                            merged_text,
                            source,
                            id
                        ],
                    )?;
                    updated += 1;
                }
                None => {
                    tx.execute(
                        "INSERT INTO finance
                         (enterprise_id, year, report_type, total_assets, total_liabilities,
                          revenue, net_profit, debt_ratio, source, metrics_json)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                        rusqlite::params![
                            enterprise_id,
                            rec.year,
                            rec.report_type,
                            rec.total_assets,
                            rec.total_liabilities,
                            rec.revenue,
                            rec.net_profit,
                            rec.debt_ratio,
                            rec.source,
                            metrics
                        ],
                    )?;
                    inserted += 1;
                }
            }
        }

        for n in &result.news {
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM news WHERE enterprise_id = ?1 AND title = ?2",
                rusqlite::params![enterprise_id, n.title],
                |r| r.get(0),
            )?;
            if exists == 0 {
                tx.execute(
                    "INSERT INTO news (enterprise_id, title, content, source, url, published_at, sentiment)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![
                        enterprise_id,
                        n.title,
                        n.content,
                        n.source,
                        n.url,
                        n.published_at,
                        if n.sentiment.is_empty() { "neutral" } else { &n.sentiment }
                    ],
                )?;
                inserted += 1;
            }
        }

        for l in &result.legal {
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM legal_record WHERE enterprise_id = ?1 AND title = ?2",
                rusqlite::params![enterprise_id, l.title],
                |r| r.get(0),
            )?;
            if exists == 0 {
                tx.execute(
                    "INSERT INTO legal_record
                     (enterprise_id, case_no, doc_type, title, court, cause, amount, status, judgment_date, source)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![
                        enterprise_id,
                        l.case_no,
                        l.doc_type,
                        l.title,
                        l.court,
                        l.cause,
                        l.amount,
                        l.status,
                        l.judgment_date,
                        l.source
                    ],
                )?;
                inserted += 1;
            }
        }

        tx.commit()?;
        Ok((inserted, updated))
    })
}

fn merge_source(old: &str, new: &str) -> String {
    if new.is_empty() || old.contains(new) {
        old.to_string()
    } else if old.is_empty() {
        new.to_string()
    } else {
        format!("{old}+{new}").chars().take(200).collect()
    }
}

/// 拉取一个维度（财务：关键指标 + 三表合并；其余单源）
pub async fn fetch_dimension(code: &str, dimension: &str) -> FetchResult {
    match dimension {
        "finance" => {
            let mut merged = FetchResult {
                dimension: "finance".into(),
                source: String::new(),
                ..Default::default()
            };
            let mut sources: Vec<String> = Vec::new();
            let mut errors: Vec<String> = Vec::new();
            match sina::fetch_abstract(code).await {
                Ok(records) => {
                    sources.push("新浪/关键指标".into());
                    merged.finance.extend(records);
                }
                Err(err) => errors.push(format!("新浪关键指标: {err}")),
            }
            match sina::fetch_statements(code).await {
                Ok(records) => {
                    sources.push("新浪/三表".into());
                    let mut by_year: BTreeMap<String, FinanceRecord> = BTreeMap::new();
                    for r in records {
                        by_year.insert(r.year.clone(), r);
                    }
                    // 按年份合并到已有记录（三表提供绝对值科目）
                    for rec in merged.finance.iter_mut() {
                        if let Some(extra) = by_year.get(&rec.year) {
                            for (k, v) in extra.metrics.clone() {
                                rec.metrics.insert(k, v);
                            }
                            if rec.total_assets == 0.0 {
                                rec.total_assets = extra.total_assets;
                            }
                            if rec.total_liabilities == 0.0 {
                                rec.total_liabilities = extra.total_liabilities;
                            }
                            rec.source = merge_source(&rec.source, &extra.source);
                        }
                    }
                }
                Err(err) => errors.push(format!("新浪三表: {err}")),
            }
            merged.source = sources.join("+");
            if merged.finance.is_empty() {
                merged.error = Some(if errors.is_empty() {
                    "无财务数据".into()
                } else {
                    errors.join("; ")
                });
            }
            merged
        }
        "news" => eastmoney::fetch_news(code, 30).await,
        "legal" => cninfo::fetch_legal(code, 540).await,
        other => FetchResult::empty(other, "none", format!("unsupported dimension: {other}")),
    }
}

/// 刷新一家企业：拉取 → 入库 → 记录数据状态 → 生成预警
pub async fn refresh_enterprise(db: &Db, enterprise_id: i64, dimensions: Option<Vec<String>>) -> Result<Value> {
    let ent = db.with(|conn| {
        let row = conn.query_row(
            "SELECT id, name, stock_code, data_status_json FROM enterprise WHERE id = ?1",
            [enterprise_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        );
        match row {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    let Some((id, name, code, status_json)) = ent else {
        return Ok(json!({ "error": format!("企业不存在: {enterprise_id}") }));
    };
    if code.trim().is_empty() {
        return Ok(json!({
            "enterprise": { "id": id, "name": name, "stock_code": code },
            "error": "无股票代码（非上市企业，需人工数据源）",
        }));
    }

    let dims = dimensions.unwrap_or_else(|| vec!["finance".into(), "news".into(), "legal".into()]);
    let mut status = load_json_map(&status_json);
    let mut out_dims = Map::new();

    for dim in &dims {
        let result = fetch_dimension(&code, dim).await;
        if !result.ok() {
            status.insert(dim.clone(), json!("error"));
            out_dims.insert(
                dim.clone(),
                json!({
                    "ok": false,
                    "source": result.source,
                    "error": result.error,
                    "gap": result.gap,
                }),
            );
            continue;
        }
        let (inserted, updated) = upsert_records(db, id, &result)?;
        let state = if result.total() > 0 { "ok" } else { "empty" };
        status.insert(dim.clone(), json!(state));
        out_dims.insert(
            dim.clone(),
            json!({
                "ok": true,
                "source": result.source,
                "fetched": result.total(),
                "inserted": inserted,
                "updated": updated,
            }),
        );
    }

    let status_value = Value::Object(status);
    db.with(|conn| {
        conn.execute(
            "UPDATE enterprise SET data_status_json = ?1 WHERE id = ?2",
            rusqlite::params![status_value.to_string(), id],
        )?;
        Ok(())
    })?;

    let alerts_created = crate::services::alerts::generate_for_enterprise(db, id, "scoring")
        .map(|v| v.get("created").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0))
        .unwrap_or(0);

    let _ = Instant::now();
    Ok(json!({
        "enterprise": { "id": id, "name": name, "stock_code": code },
        "dimensions": Value::Object(out_dims),
        "data_status": status_value,
        "alerts_created": alerts_created,
    }))
}

#[allow(dead_code)]
fn _unused(_d: Duration) {}

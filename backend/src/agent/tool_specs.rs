//! 工具元数据的**单一真源**（P1：声明式注册）。
//!
//! 背景（真实缺陷，不是假想）：原先"哪些工具需要走异步分发"是 `tools.rs` 里一份**手抄名单**
//! （`is_async_tool`）。新增 `list_industry_boards` / `get_board_constituents` / `get_stock_snapshot`
//! 时漏登记，结果模型**看得见工具却调不动**，运行时回 `unknown tool: list_industry_boards`——
//! 排查花了三轮（先怀疑编码、再怀疑请求头，最后才发现是名单没登记）。
//!
//! 本模块把这层元数据收敛到一处：
//! - 分发器（同步/异步）由 `async_` 声明**派生**，不再手抄；
//! - `audit()` 可校验"声明表 ↔ 实际注册的工具名"是否一致，漏登记会被立刻发现；
//! - 新增工具时：在声明表加一行 + 写分发分支（Rust 的 match 无法纯数据驱动，这是上限）。
//!
//! 只收敛**会引发分发错误**的元数据（是否异步）。`read_only` 仍由 `reg.register()` 持有，
//! 避免出现"两处都能改、以谁为准"的新歧义；`audit()` 会把两者一并核对。

/// 工具声明。`async_`：是否需要异步分发（访问网络、写库、插件/MCP）。
pub struct ToolSpec {
    pub name: &'static str,
    pub async_: bool,
    /// 为什么是异步（写给自己和后来人看的，避免又靠猜）
    pub why: &'static str,
}

macro_rules! sync_tool {
    ($name:literal, $why:literal) => {
        ToolSpec { name: $name, async_: false, why: $why }
    };
}
macro_rules! async_tool {
    ($name:literal, $why:literal) => {
        ToolSpec { name: $name, async_: true, why: $why }
    };
}

/// 全部内置工具的元数据。**新增工具必须在此登记**（`audit()` 会校验）。
pub const SPECS: &[ToolSpec] = &[
    // —— 只查库、纯同步 ——
    sync_tool!("search_enterprise", "查询库内企业"),
    sync_tool!("get_score_profile", "读取库内评分"),
    sync_tool!("get_risk_facts", "读取库内风险事实"),
    sync_tool!("list_enterprises_by_level", "查询库内企业列表"),
    sync_tool!("get_platform_overview", "平台总览统计"),
    sync_tool!("list_alerts", "读取预警列表"),
    sync_tool!("list_skills", "读取技能列表"),
    sync_tool!("load_skill", "读取技能内容"),
    sync_tool!("get_alert_report", "读取预警报告"),
    sync_tool!("get_financial_analysis", "读取库内财务分析"),
    sync_tool!("compare_financials", "库内多企业对比"),
    sync_tool!("screen_by_financial_metric", "库内指标筛选"),
    sync_tool!("list_tables", "读取表格列表"),
    sync_tool!("get_table", "读取表格内容"),
    sync_tool!("list_attachments", "读取附件列表"),
    // —— 访问网络 ——
    async_tool!("list_industry_boards", "访问东方财富板块接口"),
    async_tool!("get_board_constituents", "访问东方财富板块成分接口"),
    async_tool!("get_stock_snapshot", "访问东方财富行情接口"),
    async_tool!("resolve_stock_code", "访问外部证券代码解析"),
    async_tool!("read_attachment", "解析附件（OCR/文档解析，耗时）"),
    // —— 写操作（需授权，故走异步 + 授权闸门）——
    async_tool!("add_enterprise", "写库 + 拉取公开数据"),
    async_tool!("refresh_enterprise_data", "写库 + 拉取公开数据"),
    async_tool!("run_risk_analysis", "写库 + 长耗时研判"),
    async_tool!("handle_alert", "写库（处置预警）"),
    async_tool!("create_table", "写库（建表）"),
    async_tool!("write_table_cells", "写库（写单元格）"),
    async_tool!("validate_table", "写库（校验并落库）"),
    async_tool!("ingest_table", "写库（导入表格）"),
];

/// 查声明。未登记返回 `None`——**这是应该被 `audit()` 拦住的编程错误**，不是运行时输入错误。
pub fn spec(name: &str) -> Option<&'static ToolSpec> {
    SPECS.iter().find(|s| s.name == name)
}

/// 是否走异步分发。未登记时**保守返回 true**（宁可多一次异步调用，也不要再出现"调不动"）。
/// 前缀规则（custom_/mcp_ 为动态工具）保留。
pub fn is_async(name: &str) -> bool {
    if name.starts_with("custom_") || name.starts_with("mcp_") {
        return true;
    }
    spec(name).map(|s| s.async_).unwrap_or(true)
}

/// 校验声明表与实际注册的工具名是否一致。
///
/// 返回问题列表（空 = 一致）：
/// - `missing`：注册了但没登记的（**就是当初 `unknown tool` 的成因**）
/// - `extra`：登记了但没注册的（删除工具后忘了清理）
pub fn audit(registered: &[String]) -> Vec<String> {
    let mut problems = Vec::new();
    for name in registered {
        if name.starts_with("custom_") || name.starts_with("mcp_") {
            continue; // 动态工具
        }
        if spec(name).is_none() {
            problems.push(format!("missing: 工具 `{name}` 已注册但未在 tool_specs.rs 登记（会导致分发错误）"));
        }
    }
    for s in SPECS {
        if !registered.iter().any(|n| n == s.name) {
            problems.push(format!("extra: 声明表里的 `{}` 未在注册表中出现（工具已删除？）", s.name));
        }
    }
    problems
}

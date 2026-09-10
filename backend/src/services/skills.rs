//! 技能库：可复用的任务指令模板（与 Python 版 `app/skills/service.py` 对齐）。
//!
//! Agent 集成方式（保持 system 提示词静态 → 缓存友好）：
//! - system 提示词里只写一句"可用 list_skills / load_skill 获取专门方法"
//! - 技能全文通过工具结果注入，不污染静态前缀

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::db::Db;
use crate::util::now_db;

pub const BUILTIN_SKILLS: [(&str, &str, &str); 5] = [
    (
        "企业风险评估报告",
        "对指定企业输出一份结构化风险评估报告（含六维评分、证据链、结论与建议）",
        r#"# 企业风险评估报告

按以下步骤执行：
1. 用 `search_enterprise` 定位企业，拿到 id；
2. 用 `get_score_profile` 取六维评分与评级；
3. 用 `get_risk_facts` 取风险事实（至少覆盖得分最低的两个维度）；
4. 输出报告，结构固定：

## 一、企业概况
（名称、行业、数据来源）

## 二、风险评级
综合评分 / 评级（AAA~C）/ 风险等级，并说明数据完整度

## 三、六维评分
逐维列出分数与一句话依据（数据不足的维度要如实标注）

## 四、关键风险点
按严重程度排序，每条附证据来源与时间

## 五、处置建议
2~4 条可执行动作，区分"立即处理"与"持续监控"

要求：只使用工具返回的数据；结尾注明"数据来自公开信源，不构成投资建议"。"#,
    ),
    (
        "多企业对比分析",
        "对比 2~3 家企业的六维评分、风险等级与关键差异，给出选择建议",
        r#"# 多企业对比分析

1. 对每家企业依次 `search_enterprise` → `get_score_profile`；
2. 用表格对比：企业 | 综合评分 | 评级 | 财务 | 法律 | 舆情 | 经营 | 信用 | 供应链；
3. 指出差异最大的两个维度，并解释原因（引用证据）；
4. 结论：哪家更稳健、哪家需要重点监控，各给一条建议。

注意：评分缺失（gray）的维度要标注"数据不足"，不要当成满分或零分。"#,
    ),
    (
        "预警处置建议",
        "针对预警工单给出处置方案与跟踪建议",
        r#"# 预警处置建议

1. `list_alerts` 找到目标预警（按企业或状态筛选）；
2. 阅读该预警的证据链与处置流水；
3. 输出：
   - 风险性质判断（是实质性风险还是数据噪音）
   - 需要核实的 2~3 个关键事实
   - 处置动作建议（含责任岗位、时限）
   - 后续跟踪指标与复评时间点
4. 如用户确认要处置，调用 `handle_alert`（需授权）记录处置。"#,
    ),
    (
        "舆情专项研判",
        "聚焦舆情声誉维度，分析负面舆情来源、趋势与影响",
        r#"# 舆情专项研判

1. `search_enterprise` → `get_risk_facts`（dimension=news）取舆情事实；
2. 归类负面舆情：合规监管 / 经营业绩 / 产品质量 / 劳资关系 / 资本市场；
3. 判断传播趋势（是否集中爆发、是否有权威媒体介入）；
4. 输出：舆情风险等级、需重点关注的 3 条报道（附来源）、对外沟通与应对建议。"#,
    ),
    (
        "财务分析",
        "用金融分析模块做财报分析：KPI、杜邦分解、Z/F/M 模型、同业对标、异常勾稽",
        r#"# 财务分析

## 取数顺序
1. `search_enterprise` 定位企业，拿到 id；
2. `get_financial_analysis(enterprise_id)` 一次拿全：KPI、杜邦分解、Altman Z/Z''、Piotroski F、Beneish M、同业分位、异常信号；
3. 若返回 `available=false`：说明该企业无公开财报（非上市或未采集），提示用户可用 `refresh_enterprise_data`（写操作，需授权）拉取，或确认股票代码；
4. 需要横向比较时用 `compare_financials([id1, id2, ...])`；需要按指标筛选用 `screen_by_financial_metric`。

## 输出结构（固定）
## 一、结论摘要
3~5 条，先给判断（健康/承压/高风险），每条附关键数字与年份。
## 二、盈利与成长
营收/归母净利润/毛利率/净利率/ROE 的**水平值与同比方向**，指出趋势拐点。
## 三、杜邦分解
ROE = 净利率 × 总资产周转率 × 权益乘数，说明最近一期变动主要由哪个因素驱动。
## 四、财务预警模型
- Altman Z''（账面口径）：分数 + 区间（>2.6 安全 / 1.1~2.6 灰色 / <1.1 困境）；
- Altman Z（市值口径）：如无市值数据则明确写"不可计算"；
- Piotroski F-Score：得分 x/9，列出未通过项；
- Beneish M-Score：分数 + 是否 > -1.78，并注明含近似项（若有）。
## 五、异常信号
逐条列 `anomalies`：标题 + 具体数字 + 可能原因 + 需核实材料。
## 六、同业对标
关键指标在可比企业中的分位（≥75% 为优势，≤25% 为劣势）。
## 七、数据说明
覆盖期数、缺失指标、口径提示。

## 硬性要求
- 数字必须来自工具返回，标注年份与单位（万元/%/倍/天）；
- 缺失数据写"数据不足"，不得用 0 或行业均值替代；
- 模型分数必须同时给阈值，避免只给结论；
- 结尾注明"数据来自公开信源，模型结果为规则化测算，不构成投资建议"。"#,
    ),
];

/// 内置技能入库（幂等：同名跳过）
pub fn seed_builtin(db: &Db) -> Result<i64> {
    let now = now_db();
    db.with(|conn| {
        let mut created = 0i64;
        for (name, description, content) in BUILTIN_SKILLS.iter() {
            let exists: Option<i64> = conn
                .query_row("SELECT id FROM skill WHERE name = ?1", [name], |r| r.get(0))
                .optional()?;
            if exists.is_some() {
                continue;
            }
            conn.execute(
                "INSERT INTO skill (name, description, content, enabled, builtin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, 1, ?4, ?4)",
                params![name, description, content, now],
            )?;
            created += 1;
        }
        Ok(created)
    })
}

pub fn list(db: &Db, enabled_only: bool) -> Result<Value> {
    let rows = db.with(|conn| {
        let sql = if enabled_only {
            "SELECT id, name, description, content, enabled, builtin, updated_at FROM skill WHERE enabled = 1 ORDER BY builtin DESC, id"
        } else {
            "SELECT id, name, description, content, enabled, builtin, updated_at FROM skill ORDER BY builtin DESC, id"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "description": r.get::<_, String>(2)?,
                    "content": r.get::<_, String>(3)?,
                    "enabled": r.get::<_, i64>(4)? != 0,
                    "builtin": r.get::<_, i64>(5)? != 0,
                    "updated_at": crate::util::db_to_iso(&r.get::<_, String>(6)?),
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(json!({ "total": rows.len(), "items": rows }))
}

pub fn get_by_name(db: &Db, name: &str) -> Result<Option<(String, String, String, bool)>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT name, description, content, enabled FROM skill WHERE name = ?1",
                [name],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)? != 0,
                    ))
                },
            )
            .optional()?;
        Ok(row)
    })
}

/// 供 list_skills 工具使用（只返回名称与描述，避免污染上下文）
pub fn skills_for_tool(db: &Db) -> Result<Vec<Value>> {
    db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT name, description FROM skill WHERE enabled = 1 ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(json!({
                    "name": r.get::<_, String>(0)?,
                    "description": r.get::<_, String>(1)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn create(db: &Db, name: &str, description: &str, content: &str) -> Result<Value> {
    let name = name.trim();
    if name.is_empty() || content.trim().is_empty() {
        return Ok(json!({ "error": "技能名称与内容不能为空" }));
    }
    let now = now_db();
    db.with(|conn| {
        let exists: Option<i64> = conn
            .query_row("SELECT id FROM skill WHERE name = ?1", [name], |r| r.get(0))
            .optional()?;
        if exists.is_some() {
            return Ok(json!({ "error": format!("技能已存在：{name}") }));
        }
        conn.execute(
            "INSERT INTO skill (name, description, content, enabled, builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, 0, ?4, ?4)",
            params![name, description, content, now],
        )?;
        Ok(json!({ "skill_id": conn.last_insert_rowid(), "name": name }))
    })
}

pub fn update(db: &Db, skill_id: i64, body: &Value) -> Result<Value> {
    let exists: Option<i64> = db.with(|conn| {
        Ok(conn
            .query_row("SELECT id FROM skill WHERE id = ?1", [skill_id], |r| r.get(0))
            .optional()?)
    })?;
    if exists.is_none() {
        return Ok(json!({ "error": format!("技能不存在: {skill_id}") }));
    }
    db.with(|conn| {
        for key in ["name", "description", "content"] {
            if let Some(v) = body.get(key).and_then(|v| v.as_str()) {
                conn.execute(
                    &format!("UPDATE skill SET {key} = ?1 WHERE id = ?2"),
                    params![v, skill_id],
                )?;
            }
        }
        if let Some(v) = body.get("enabled").and_then(|v| v.as_bool()) {
            conn.execute(
                "UPDATE skill SET enabled = ?1 WHERE id = ?2",
                params![v as i64, skill_id],
            )?;
        }
        conn.execute(
            "UPDATE skill SET updated_at = ?1 WHERE id = ?2",
            params![now_db(), skill_id],
        )?;
        Ok(json!({ "ok": true, "skill_id": skill_id }))
    })
}

pub fn delete(db: &Db, skill_id: i64) -> Result<Value> {
    db.with(|conn| {
        let row: Option<(String, i64)> = conn
            .query_row("SELECT name, builtin FROM skill WHERE id = ?1", [skill_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .optional()?;
        let (name, builtin) = match row {
            Some(v) => v,
            None => return Ok(json!({ "error": format!("技能不存在: {skill_id}") })),
        };
        if builtin != 0 {
            return Ok(json!({ "error": "内置技能不可删除，可将其停用" }));
        }
        conn.execute("DELETE FROM skill WHERE id = ?1", [skill_id])?;
        Ok(json!({ "deleted": skill_id, "name": name }))
    })
}

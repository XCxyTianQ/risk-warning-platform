//! 数据库连接与初始化。
//!
//! P0 阶段采用"单连接 + 互斥锁"的简单方案（SQLite 串行化足够）：
//! 后续如需并发查询可换成连接池（r2d2 / deadpool-sqlite）。

pub mod schema;
pub mod seed;

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::config::Config;

/// 全应用共享的数据库句柄
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)
            .with_context(|| format!("打开数据库失败：{}", path.display()))?;
        conn.execute_batch(schema::SCHEMA).context("初始化表结构失败")?;
        migrate(&conn).context("升级表结构失败")?;
        // 重建过的表会连索引一起被丢弃，这里再跑一遍 SCHEMA（全部 IF NOT EXISTS）补回来
        conn.execute_batch(schema::SCHEMA).context("重建索引失败")?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// 借出连接执行一段只读/写逻辑（锁内完成，避免跨 await 持有）
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        f(&guard)
    }

    pub fn enterprise_count(&self) -> Result<i64> {
        self.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM enterprise", [], |r| r.get(0))?))
    }
}

/// 轻量迁移：`CREATE TABLE IF NOT EXISTS` 不会给既有库补列，这里按需 ALTER。
///
/// 目前需要补的列：
///  * `table_doc.macro_json`（P6 加入的表格级脚本宏）
fn migrate(conn: &Connection) -> Result<()> {
    let has_column = |table: &str, column: &str| -> bool {
        let sql = format!("PRAGMA table_info({table})");
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return false;
        };
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();
        names.iter().any(|n| n == column)
    };

    if !has_column("table_doc", "macro_json") {
        conn.execute_batch("ALTER TABLE table_doc ADD COLUMN macro_json TEXT NOT NULL DEFAULT '[]'")?;
        println!("[db] 迁移：table_doc 增加 macro_json 列");
    }
    rebuild_legacy_tables(conn)?;
    Ok(())
}

/// 把"旧库（Python/SQLAlchemy 建的表）"重建成新 schema。
///
/// 为什么必须做：旧库大量列是 `NOT NULL` **却没有 DEFAULT**，而 Rust 侧的 INSERT
/// 只写自己关心的列、其余靠默认值补齐（`chat_session` 只插 4 列）。在旧库上这会直接
/// 报 `NOT NULL constraint failed`——表现为"升级后新建会话/新增企业/生成预警全部失败"。
/// SQLite 不能修改既有列的默认值，只能重建表：改名 → 按新 schema 建 → 拷贝列交集 → 删旧表。
///
/// 只在**确有风险**时才重建：旧表里存在"NOT NULL 且无默认值、但新 schema 给了默认值"的列。
fn rebuild_legacy_tables(conn: &Connection) -> Result<()> {
    for (table, create_sql, canonical) in schema::create_table_statements() {
        let existing = table_info(conn, &table);
        if existing.is_empty() {
            continue // 表不存在（新库已由 SCHEMA 建好，理论上不会走到这里）
        }
        let canonical_defaults: std::collections::HashSet<&str> = canonical
            .iter()
            .filter(|(_, has_default)| *has_default)
            .map(|(name, _)| name.as_str())
            .collect();

        let risky = existing
            .iter()
            .any(|col| col.notnull && col.default.is_none() && canonical_defaults.contains(col.name.as_str()));
        if !risky {
            continue
        }

        let old_names: Vec<&str> = existing.iter().map(|c| c.name.as_str()).collect();
        let copy_cols: Vec<&str> = canonical
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| old_names.contains(name))
            .collect();
        if copy_cols.is_empty() {
            continue
        }
        let cols = copy_cols.join(", ");
        let temp = format!("{table}__legacy_backup");
        // 三个关键点（踩过的坑）：
        //  1) `legacy_alter_table=ON`：否则 SQLite 3.25+ 在 RENAME 时会把**别的表**里的
        //     `REFERENCES 本表(id)` 一起改写成指向临时表名，删掉临时表后那些表就永久引用一个不存在的表
        //     （表现为之后 INSERT 其它表报 "no such table: xxx__legacy_backup"）；
        //  2) 关掉外键约束，避免 DROP 旧表时触发级联；
        //  3) 整个重建放进一个事务，失败即回滚。
        let sql = format!(
            "PRAGMA foreign_keys=OFF;\n\
             PRAGMA legacy_alter_table=ON;\n\
             BEGIN;\n\
             ALTER TABLE {table} RENAME TO {temp};\n\
             {create_sql}\n\
             INSERT INTO {table} ({cols}) SELECT {cols} FROM {temp};\n\
             DROP TABLE {temp};\n\
             COMMIT;\n\
             PRAGMA legacy_alter_table=OFF;\n\
             PRAGMA foreign_keys=ON;"
        );
        conn.execute_batch(&sql)
            .with_context(|| format!("重建旧表 {table} 失败"))?;
        println!("[db] 迁移：重建旧表 {table}（补齐列默认值，避免 NOT NULL 约束失败）");
    }
    Ok(())
}

struct ColInfo {
    name: String,
    notnull: bool,
    default: Option<String>,
}

fn table_info(conn: &Connection, table: &str) -> Vec<ColInfo> {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new()
    };
    let rows = stmt.query_map([], |r| {
        Ok(ColInfo {
            name: r.get::<_, String>(1)?,
            notnull: r.get::<_, i64>(3)? != 0,
            default: r.get::<_, Option<String>>(4)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// 初始化数据库：建表 + 空库时灌入样例数据
pub fn init(cfg: &Config) -> Result<Db> {
    let db = Db::open(&cfg.db_path())?;
    let count = db.enterprise_count()?;
    if count == 0 {
        match seed::seed_from_samples(&db, &cfg.samples_dir) {
            Ok(n) => println!("[db] 已灌入样例企业 {n} 家"),
            Err(err) => eprintln!("[db] 样例数据加载失败（忽略）：{err:#}"),
        }
    } else {
        println!("[db] 已有企业 {count} 家，跳过样例灌入");
    }
    Ok(db)
}

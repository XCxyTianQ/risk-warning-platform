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
    Ok(())
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

//! 应用共享状态。
//!
//! `cfg` 是启动期只读配置（路径/端口/前端目录）；`rt` 是可在设置面板热修改的运行时子集。
//! 读取方式：`let rt = state.rt();`（内部克隆，字段很少，成本可忽略）。

use std::sync::{Arc, Mutex, RwLock};

use crate::config::{Config, RuntimeCfg};
use crate::db::Db;
use crate::llm::preheat::Warmer;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub cfg: Arc<Config>,
    pub rt: Arc<RwLock<RuntimeCfg>>,
    pub warmer: Arc<Mutex<Warmer>>,
}

impl AppState {
    pub fn new(db: Db, cfg: Arc<Config>) -> Self {
        let rt = cfg.runtime.clone();
        Self {
            db,
            cfg,
            rt: Arc::new(RwLock::new(rt)),
            warmer: Arc::new(Mutex::new(Warmer::default())),
        }
    }

    /// 取一份运行时配置快照
    pub fn rt(&self) -> RuntimeCfg {
        self.rt.read().expect("runtime cfg lock").clone()
    }

    /// 覆盖运行时配置（设置保存后调用）
    pub fn set_rt(&self, next: RuntimeCfg) {
        *self.rt.write().expect("runtime cfg lock") = next;
    }
}

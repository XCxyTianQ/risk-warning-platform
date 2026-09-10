//! 动作工具授权（对齐 Harness/Codex 的 approval 机制）。
//!
//! 写操作（添加企业 / 刷新数据 / 处置预警）执行前挂起，等待前端 POST /api/chat/approve；
//! 超时视为拒绝。挂起期间 SSE 流仍在等待，不阻塞其他会话。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Notify;

#[allow(dead_code)] // 字段用于诊断与后续审计留痕
pub struct Pending {
    pub id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub name: String,
    pub args: Value,
    pub description: String,
    pub approved: bool,
    pub decided: bool,
    pub notify: Arc<Notify>,
}

type Slot = Arc<Mutex<Pending>>;

static REGISTRY: Mutex<Option<HashMap<String, Slot>>> = Mutex::new(None);

fn registry() -> std::sync::MutexGuard<'static, Option<HashMap<String, Slot>>> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn create(
    session_id: &str,
    tool_call_id: &str,
    name: &str,
    args: Value,
    description: &str,
) -> Slot {
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let slot = Arc::new(Mutex::new(Pending {
        id: id.clone(),
        session_id: session_id.to_string(),
        tool_call_id: tool_call_id.to_string(),
        name: name.to_string(),
        args,
        description: description.to_string(),
        approved: false,
        decided: false,
        notify: Arc::new(Notify::new()),
    }));
    registry()
        .get_or_insert_with(HashMap::new)
        .insert(id, slot.clone());
    slot
}

/// 等待用户决策；返回是否授权（超时视为拒绝）
pub async fn wait_for(slot: &Slot, timeout_s: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_s);
    loop {
        {
            let guard = slot.lock().expect("approval lock");
            if guard.decided {
                return guard.approved;
            }
        }
        let notify = { slot.lock().expect("approval lock").notify.clone() };
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        if tokio::time::timeout(remaining, notify.notified()).await.is_err() {
            return false;
        }
    }
}

/// 前端决策：返回是否命中待审批项
pub fn resolve(approval_id: &str, approved: bool) -> bool {
    let slot = {
        let guard = registry();
        guard.as_ref().and_then(|m| m.get(approval_id).cloned())
    };
    let Some(slot) = slot else { return false };
    {
        let mut guard = slot.lock().expect("approval lock");
        guard.approved = approved;
        guard.decided = true;
    }
    slot.lock().expect("approval lock").notify.notify_waiters();
    true
}

pub fn discard(approval_id: &str) {
    if let Some(map) = registry().as_mut() {
        map.remove(approval_id);
    }
}

/// 待审批数量（诊断用）
#[allow(dead_code)]
pub fn pending_count() -> usize {
    registry().as_ref().map(|m| m.len()).unwrap_or(0)
}

//! SSE 事件封装（与前端既有协议一致）。

use axum::response::sse::Event;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub event: String,
    pub data: Value,
}

impl AgentEvent {
    pub fn new(event: &str, data: Value) -> Self {
        Self { event: event.to_string(), data }
    }

    pub fn to_sse(&self) -> Event {
        let mut data = self.data.clone();
        if let Some(obj) = data.as_object_mut() {
            obj.insert("ts".into(), Value::String(chrono::Utc::now().to_rfc3339()));
        }
        Event::default().event(self.event.clone()).data(data.to_string())
    }
}

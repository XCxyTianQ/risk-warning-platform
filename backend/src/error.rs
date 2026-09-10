//! 统一错误类型：内部 anyhow，对外 HTTP 状态码 + 可读消息。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub struct AppError {
    pub status: StatusCode,
    pub error: anyhow::Error,
}

impl AppError {
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self { status, error: anyhow::anyhow!(msg.into()) }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, msg)
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, msg)
    }

    #[allow(dead_code)]
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, error: err.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let msg = format!("{:#}", self.error);
        if self.status.is_server_error() {
            eprintln!("[error] {msg}");
        }
        (self.status, Json(json!({ "detail": msg }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

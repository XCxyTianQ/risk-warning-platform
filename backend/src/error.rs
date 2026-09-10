//! 统一错误类型：内部 anyhow，对外 500 + 可读消息（与 Python 版行为一致）。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub struct AppError(pub anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let msg = format!("{:#}", self.0);
        eprintln!("[error] {msg}");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "detail": msg }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

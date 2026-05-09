use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use thiserror::Error;

/// Wszystkie błędy wystawiane na zewnątrz (handlerów). Mapują się na
/// HTTP status + JSON body z polami `error` (kod maszynowy) i `message`
/// (czytelny dla człowieka).
#[derive(Debug, Error)]
pub enum AppError {
    #[error("nieprawidłowe dane wejściowe: {0}")]
    BadRequest(String),

    #[error("brak autoryzacji")]
    Unauthorized,

    #[error("konflikt: {0}")]
    Conflict(String),

    #[error("nie znaleziono")]
    NotFound,

    #[error("błąd bazy danych: {0}")]
    Database(#[from] sqlx::Error),

    #[error("błąd hashowania hasła: {0}")]
    PasswordHash(String),

    #[error("błąd JWT: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("błąd wewnętrzny: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::Database(e) => {
                // Specyficzne mapowanie unique violation -> 409.
                if let Some(db_err) = e.as_database_error() {
                    if db_err.is_unique_violation() {
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "error": "conflict",
                                "message": "rekord o takich danych już istnieje",
                            })),
                        )
                            .into_response();
                    }
                }
                tracing::error!("db error: {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "database")
            }
            AppError::PasswordHash(msg) => {
                tracing::error!("argon2 error: {msg}");
                (StatusCode::INTERNAL_SERVER_ERROR, "password_hash")
            }
            AppError::Jwt(e) => {
                tracing::warn!("jwt error: {e:?}");
                (StatusCode::UNAUTHORIZED, "invalid_token")
            }
            AppError::Internal(e) => {
                tracing::error!("internal error: {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };
        let message = self.to_string();
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;

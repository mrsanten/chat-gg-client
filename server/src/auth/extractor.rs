use crate::auth::jwt;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::Uuid;

/// Extractor pokazujący zalogowanego usera. Wymaga nagłówka:
///   `Authorization: Bearer <jwt>`
/// Jeśli brak nagłówka, niepoprawny format lub token nieważny → 401.
pub struct AuthUser {
    pub account_id: Uuid,
    pub username: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?
            .trim();
        let claims = jwt::verify(&state.jwt, token)?;
        Ok(Self {
            account_id: claims.account_id()?,
            username: claims.username,
        })
    }
}

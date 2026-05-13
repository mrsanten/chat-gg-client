//! API keys per-account: synchronizacja między urządzeniami.
//!
//! Klient pyta `GET /me/secrets` po loginie, mergie z lokalnymi settings
//! (server source-of-truth). Przy zmianie klucza w UI `PUT /me/secrets/{provider}`.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ApiKeyRow {
    pub provider: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateKeyReq {
    pub api_key: String,
}

const ALLOWED: &[&str] = &["openai", "anthropic", "moonshot"];

/// GET /me/secrets — wszystkie zapisane klucze.
pub async fn list_secrets(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<ApiKeyRow>>> {
    let rows: Vec<ApiKeyRow> = sqlx::query_as(
        r#"SELECT provider, api_key FROM account_api_keys WHERE account_id = $1"#,
    )
    .bind(user.account_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// PUT /me/secrets/{provider} — upsert klucz dla providera.
/// Pusty `api_key` = DELETE (clear).
pub async fn upsert_secret(
    State(state): State<AppState>,
    user: AuthUser,
    Path(provider): Path<String>,
    Json(req): Json<UpdateKeyReq>,
) -> AppResult<StatusCode> {
    if !ALLOWED.contains(&provider.as_str()) {
        return Err(AppError::BadRequest(format!(
            "provider musi być jednym z: {}",
            ALLOWED.join(", ")
        )));
    }
    if req.api_key.trim().is_empty() {
        // Pusty = clear
        sqlx::query(
            r#"DELETE FROM account_api_keys WHERE account_id = $1 AND provider = $2"#,
        )
        .bind(user.account_id)
        .bind(&provider)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO account_api_keys (account_id, provider, api_key, updated_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (account_id, provider) DO UPDATE
            SET api_key = EXCLUDED.api_key, updated_at = now()
            "#,
        )
        .bind(user.account_id)
        .bind(&provider)
        .bind(req.api_key.trim())
        .execute(&state.db)
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

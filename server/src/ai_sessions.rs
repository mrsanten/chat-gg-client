//! AI chat sessions persisted server-side, sync między urządzeniami.
//!
//! Sesja = tytuł + modelId + tablica wiadomości. Pełna sesja serializowana
//! do JSONB w bazie. Klient PUT-uje pełną sesję przy każdej zmianie
//! (debounced), GET pobiera listę po loginie.

use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AiSession {
    pub id: Uuid,
    pub model_id: String,
    pub title: String,
    pub messages: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertSessionReq {
    pub id: Uuid,
    pub model_id: String,
    pub title: String,
    pub messages: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// GET /me/sessions — wszystkie sesje AI tego konta, sortowane DESC po updated_at.
pub async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<AiSession>>> {
    let rows: Vec<AiSession> = sqlx::query_as(
        r#"
        SELECT id, model_id, title, messages, created_at, updated_at
        FROM ai_sessions
        WHERE account_id = $1
        ORDER BY updated_at DESC
        "#,
    )
    .bind(user.account_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// PUT /me/sessions/{id} — upsert całej sesji.
pub async fn upsert_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<UpsertSessionReq>,
) -> AppResult<StatusCode> {
    if id != req.id {
        return Err(crate::error::AppError::BadRequest(
            "URL session_id i body.id muszą być takie same".into(),
        ));
    }
    // Limit zdroworozsądkowy żeby nie wbić 100 MB JSON-a w bazę.
    let body_size = serde_json::to_string(&req.messages)
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if body_size > 2 * 1024 * 1024 {
        return Err(crate::error::AppError::BadRequest(
            "Sesja > 2 MB. Skróć history.".into(),
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO ai_sessions (id, account_id, model_id, title, messages, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE
        SET model_id = EXCLUDED.model_id,
            title = EXCLUDED.title,
            messages = EXCLUDED.messages,
            updated_at = EXCLUDED.updated_at
        WHERE ai_sessions.account_id = $2
        "#,
    )
    .bind(req.id)
    .bind(user.account_id)
    .bind(&req.model_id)
    .bind(&req.title)
    .bind(&req.messages)
    .bind(req.created_at)
    .bind(req.updated_at)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /me/sessions/{id}
pub async fn delete_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query(r#"DELETE FROM ai_sessions WHERE id = $1 AND account_id = $2"#)
        .bind(id)
        .bind(user.account_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

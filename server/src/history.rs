use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    /// Username peera (case-insensitive).
    pub peer: String,
    /// Maksymalna liczba zwracanych wiadomości (1..=200, domyślnie 50).
    pub limit: Option<u32>,
    /// Page-cursor: wiadomości starsze niż ten timestamp.
    /// Jeśli puste, zwraca najnowsze.
    pub before: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MessageView {
    pub id: Uuid,
    pub from_id: Uuid,
    pub to_id: Uuid,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
}

/// GET /history?peer=username&limit=50&before=<iso8601>
///
/// Zwraca wiadomości w obu kierunkach między zalogowanym userem a peerem,
/// posortowane DESC po `created_at`. Klient może dalej paginować po
/// `before = <created_at najstarszej zwróconej>`.
pub async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<HistoryQuery>,
) -> AppResult<Json<Vec<MessageView>>> {
    if q.peer.is_empty() {
        return Err(AppError::BadRequest("peer jest wymagany".into()));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200) as i64;

    let peer_lower = q.peer.to_lowercase();
    let peer_id: Uuid =
        sqlx::query_scalar(r#"SELECT id FROM accounts WHERE username_lower = $1"#)
            .bind(&peer_lower)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;

    // Dwa indeksy `messages_conv_a/b_idx` obsługują obie strony OR.
    let rows: Vec<MessageView> = sqlx::query_as(
        r#"
        SELECT id, sender_id AS from_id, recipient_id AS to_id, body, created_at, delivered_at
        FROM messages
        WHERE ((sender_id = $1 AND recipient_id = $2)
            OR (sender_id = $2 AND recipient_id = $1))
          AND ($3::timestamptz IS NULL OR created_at < $3)
        ORDER BY created_at DESC
        LIMIT $4
        "#,
    )
    .bind(user.account_id)
    .bind(peer_id)
    .bind(q.before)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

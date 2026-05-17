use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::Json;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    /// Username peera (case-insensitive).
    pub peer: String,
    /// Maksymalna liczba zwracanych wpisów (1..=200, domyślnie 50).
    pub limit: Option<u32>,
    /// Page-cursor: wpisy starsze niż ten timestamp.
    pub before: Option<DateTime<Utc>>,
}

/// Wpis w historii — albo legacy plain text, albo MLS blob (klient sam
/// deszyfruje). Dyskryminator `kind`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryEntry {
    Plain {
        id: Uuid,
        from_id: Uuid,
        to_id: Uuid,
        body: String,
        created_at: DateTime<Utc>,
        delivered_at: Option<DateTime<Utc>>,
        images: Vec<String>,
    },
    Blob {
        id: Uuid,
        from_id: Uuid,
        to_id: Uuid,
        /// base64
        group_id: String,
        epoch: i64,
        /// base64
        ciphertext: String,
        created_at: DateTime<Utc>,
        delivered_at: Option<DateTime<Utc>>,
    },
}

#[derive(sqlx::FromRow)]
struct PlainRow {
    id: Uuid,
    from_id: Uuid,
    to_id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
    delivered_at: Option<DateTime<Utc>>,
    images: sqlx::types::Json<Vec<String>>,
}

#[derive(sqlx::FromRow)]
struct BlobRow {
    id: Uuid,
    from_id: Uuid,
    to_id: Uuid,
    group_id: Vec<u8>,
    epoch: i64,
    ciphertext: Vec<u8>,
    created_at: DateTime<Utc>,
    delivered_at: Option<DateTime<Utc>>,
}

/// GET /history?peer=username&limit=50&before=<iso8601>
///
/// Zwraca historię wiadomości w obu kierunkach między zalogowanym userem
/// a peerem. Łączy:
///   - `messages` (plain text, legacy z phase 2),
///   - `message_blobs` (MLS ciphertext z phase 3+).
///
/// Posortowane DESC po `created_at`, łącznie do `limit` wpisów. Klient sam
/// deszyfruje blob-y (przez `mls_decrypt`); jeśli klucze już rotowały i
/// epoka jest poza retencją, blob może być nieczytelny — wtedy klient
/// pokazuje placeholder „stara wiadomość".
pub async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<HistoryQuery>,
) -> AppResult<Json<Vec<HistoryEntry>>> {
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

    // Plain z `messages` (mogą być legacy). Indeks messages_conv_a/b_idx.
    let plain: Vec<PlainRow> = sqlx::query_as(
        r#"
        SELECT id, sender_id AS from_id, recipient_id AS to_id, body, created_at, delivered_at, images
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

    // Blobs z `message_blobs` (MLS ciphertext). Klient deszyfruje sam.
    let blobs: Vec<BlobRow> = sqlx::query_as(
        r#"
        SELECT id, sender_id AS from_id, recipient_id AS to_id, group_id, epoch, ciphertext, created_at, delivered_at
        FROM message_blobs
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

    // Merge i posortuj globalnie DESC, weź max `limit` wpisów.
    let mut entries: Vec<HistoryEntry> = Vec::with_capacity(plain.len() + blobs.len());
    for r in plain {
        entries.push(HistoryEntry::Plain {
            id: r.id,
            from_id: r.from_id,
            to_id: r.to_id,
            body: r.body,
            created_at: r.created_at,
            delivered_at: r.delivered_at,
            images: r.images.0,
        });
    }
    for r in blobs {
        entries.push(HistoryEntry::Blob {
            id: r.id,
            from_id: r.from_id,
            to_id: r.to_id,
            group_id: B64.encode(&r.group_id),
            epoch: r.epoch,
            ciphertext: B64.encode(&r.ciphertext),
            created_at: r.created_at,
            delivered_at: r.delivered_at,
        });
    }
    entries.sort_by(|a, b| created_at_of(b).cmp(&created_at_of(a))); // DESC
    entries.truncate(limit as usize);

    Ok(Json(entries))
}

fn created_at_of(e: &HistoryEntry) -> DateTime<Utc> {
    match e {
        HistoryEntry::Plain { created_at, .. } | HistoryEntry::Blob { created_at, .. } => {
            *created_at
        }
    }
}

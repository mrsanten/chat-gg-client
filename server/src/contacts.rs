use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::ws::PresenceStatus;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct AddContactReq {
    pub username: String,
    pub nickname: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ContactView {
    pub peer_id: Uuid,
    pub username: String,
    pub nickname: Option<String>,
    pub created_at: DateTime<Utc>,
    pub online: bool,
    /// Status presence: online/afk/offline. Bardziej granularne niż `online`,
    /// stary klient ma czytać `online`, nowy `status`.
    pub status: PresenceStatus,
    /// Opis peera (jego self-description, max 200 znaków).
    pub description: String,
}

#[derive(sqlx::FromRow)]
struct ContactRow {
    peer_id: Uuid,
    username: String,
    nickname: Option<String>,
    created_at: DateTime<Utc>,
    description: String,
}

/// POST /contacts — dodaje znajomego po username. Tworzy parę wpisów
/// (właściciel→peer i peer→właściciel), żeby relacja była wzajemna od
/// startu. Auto-friendship (bez zaproszenia) jest świadomy uproszczeniem
/// MVP.
pub async fn add_contact(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<AddContactReq>,
) -> AppResult<(StatusCode, Json<ContactView>)> {
    if req.username.is_empty() {
        return Err(AppError::BadRequest("username jest wymagany".into()));
    }
    let peer_lower = req.username.to_lowercase();
    let peer: (Uuid, String, String) = sqlx::query_as(
        r#"SELECT id, username, description FROM accounts WHERE username_lower = $1"#,
    )
    .bind(&peer_lower)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    if peer.0 == user.account_id {
        return Err(AppError::BadRequest(
            "nie możesz dodać siebie do znajomych".into(),
        ));
    }

    // Dwukierunkowy insert w transakcji. Konflikt = już są znajomymi,
    // wtedy aktualizujemy nickname po stronie ownera, drugą stronę
    // zostawiamy.
    let mut tx = state.db.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO contacts (owner_id, peer_id, nickname)
        VALUES ($1, $2, $3)
        ON CONFLICT (owner_id, peer_id) DO UPDATE
        SET nickname = EXCLUDED.nickname
        "#,
    )
    .bind(user.account_id)
    .bind(peer.0)
    .bind(&req.nickname)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO contacts (owner_id, peer_id, nickname)
        VALUES ($1, $2, NULL)
        ON CONFLICT (owner_id, peer_id) DO NOTHING
        "#,
    )
    .bind(peer.0)
    .bind(user.account_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let status = state
        .hub
        .get_status(peer.0)
        .await
        .map(PresenceStatus::from)
        .unwrap_or(PresenceStatus::Offline);
    let online = !matches!(status, PresenceStatus::Offline);
    let view = ContactView {
        peer_id: peer.0,
        username: peer.1,
        nickname: req.nickname,
        created_at: Utc::now(),
        online,
        status,
        description: peer.2,
    };
    Ok((StatusCode::CREATED, Json(view)))
}

/// GET /contacts — lista znajomych zalogowanego usera z flagą online.
pub async fn list_contacts(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<ContactView>>> {
    let rows: Vec<ContactRow> = sqlx::query_as(
        r#"
        SELECT c.peer_id, a.username, c.nickname, c.created_at, a.description
        FROM contacts c
        JOIN accounts a ON a.id = c.peer_id
        WHERE c.owner_id = $1
        ORDER BY a.username
        "#,
    )
    .bind(user.account_id)
    .fetch_all(&state.db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let status = state
            .hub
            .get_status(r.peer_id)
            .await
            .map(PresenceStatus::from)
            .unwrap_or(PresenceStatus::Offline);
        let online = !matches!(status, PresenceStatus::Offline);
        out.push(ContactView {
            peer_id: r.peer_id,
            username: r.username,
            nickname: r.nickname,
            created_at: r.created_at,
            online,
            status,
            description: r.description,
        });
    }
    Ok(Json(out))
}

/// DELETE /contacts/:peer_id — usuwa znajomego (oba kierunki).
pub async fn remove_contact(
    State(state): State<AppState>,
    user: AuthUser,
    Path(peer_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    sqlx::query(r#"DELETE FROM contacts WHERE owner_id = $1 AND peer_id = $2"#)
        .bind(user.account_id)
        .bind(peer_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(r#"DELETE FROM contacts WHERE owner_id = $1 AND peer_id = $2"#)
        .bind(peer_id)
        .bind(user.account_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

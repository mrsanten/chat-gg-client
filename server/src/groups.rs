//! Grupy: create, list, history, members.
//!
//! Każda grupa ma autora (admin) i N członków. Wiadomości w `group_messages`
//! są fan-outowane przez WS handler. REST tutaj robi tylko CRUD na grupach
//! i historię.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::ws::ServerEvent;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Broadcast `GroupsChanged` do każdego account_id w liście (oprócz None).
/// Klient po odebraniu refreshuje listę grup / członków.
async fn broadcast_groups_changed(state: &AppState, account_ids: &[Uuid]) {
    for id in account_ids {
        state.hub.send_to(*id, ServerEvent::GroupsChanged).await;
    }
}

async fn fetch_member_ids(state: &AppState, group_id: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar(r#"SELECT account_id FROM group_members WHERE group_id = $1"#)
        .bind(group_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
}

async fn ensure_admin(state: &AppState, account_id: Uuid, group_id: Uuid) -> AppResult<()> {
    let role: Option<String> = sqlx::query_scalar(
        r#"SELECT role FROM group_members WHERE group_id = $1 AND account_id = $2"#,
    )
    .bind(group_id)
    .bind(account_id)
    .fetch_optional(&state.db)
    .await?;
    match role.as_deref() {
        Some("admin") => Ok(()),
        Some(_) => Err(AppError::BadRequest(
            "Tylko admin grupy może wykonać tę akcję".into(),
        )),
        None => Err(AppError::NotFound),
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateGroupReq {
    pub name: String,
    /// Lista username-ów do dodania jako członków (oprócz autora który
    /// dostaje admina automatycznie).
    pub member_usernames: Vec<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GroupSummary {
    pub id: Uuid,
    pub name: String,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub my_role: String,
    pub member_count: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GroupMember {
    pub account_id: Uuid,
    pub username: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub avatar: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GroupMessage {
    pub id: Uuid,
    pub group_id: Uuid,
    pub sender_id: Uuid,
    pub sender_username: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub images: sqlx::types::Json<Vec<String>>,
}

/// POST /groups — utworz grupę. Autor staje się admin-em, member_usernames
/// są dodani jako members. Username-y zwracane jako not_found są pomijane
/// (best-effort).
pub async fn create_group(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateGroupReq>,
) -> AppResult<(StatusCode, Json<GroupSummary>)> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::BadRequest(
            "Nazwa grupy musi mieć 1-80 znaków".into(),
        ));
    }

    let mut tx = state.db.begin().await?;

    // Utworz grupę
    let group_id: Uuid =
        sqlx::query_scalar(r#"INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id"#)
            .bind(name)
            .bind(user.account_id)
            .fetch_one(&mut *tx)
            .await?;

    // Dodaj twórcę jako admin
    sqlx::query(
        r#"INSERT INTO group_members (group_id, account_id, role) VALUES ($1, $2, 'admin')"#,
    )
    .bind(group_id)
    .bind(user.account_id)
    .execute(&mut *tx)
    .await?;

    // Resolve i dodaj członków — pomijamy username-y które nie istnieją.
    for username in &req.member_usernames {
        let lower = username.to_lowercase();
        if let Some(member_id) = sqlx::query_scalar::<_, Uuid>(
            r#"SELECT id FROM accounts WHERE username_lower = $1"#,
        )
        .bind(&lower)
        .fetch_optional(&mut *tx)
        .await?
        {
            if member_id == user.account_id {
                continue;
            }
            sqlx::query(
                r#"INSERT INTO group_members (group_id, account_id, role)
                   VALUES ($1, $2, 'member')
                   ON CONFLICT (group_id, account_id) DO NOTHING"#,
            )
            .bind(group_id)
            .bind(member_id)
            .execute(&mut *tx)
            .await?;
        }
    }

    let summary: GroupSummary = sqlx::query_as(
        r#"
        SELECT g.id, g.name, g.created_by, g.created_at,
               m.role AS my_role,
               (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
        FROM groups g
        JOIN group_members m ON m.group_id = g.id AND m.account_id = $1
        WHERE g.id = $2
        "#,
    )
    .bind(user.account_id)
    .bind(group_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    // Powiadom wszystkich członków (autor + dodani). Klient zassie GET /groups.
    let members = fetch_member_ids(&state, group_id).await;
    broadcast_groups_changed(&state, &members).await;
    Ok((StatusCode::CREATED, Json(summary)))
}

#[derive(Debug, Deserialize)]
pub struct UpdateGroupReq {
    pub name: String,
}

/// PATCH /groups/:id — zmień nazwę grupy. Admin only.
pub async fn update_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path(group_id): Path<Uuid>,
    Json(req): Json<UpdateGroupReq>,
) -> AppResult<StatusCode> {
    ensure_admin(&state, user.account_id, group_id).await?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::BadRequest(
            "Nazwa grupy musi mieć 1-80 znaków".into(),
        ));
    }
    sqlx::query(r#"UPDATE groups SET name = $1 WHERE id = $2"#)
        .bind(name)
        .bind(group_id)
        .execute(&state.db)
        .await?;
    let members = fetch_member_ids(&state, group_id).await;
    broadcast_groups_changed(&state, &members).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct AddMemberReq {
    pub username: String,
}

/// POST /groups/:id/members — dodaj członka po username. Admin only.
pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(group_id): Path<Uuid>,
    Json(req): Json<AddMemberReq>,
) -> AppResult<StatusCode> {
    ensure_admin(&state, user.account_id, group_id).await?;
    let lower = req.username.to_lowercase();
    let target: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT id FROM accounts WHERE username_lower = $1"#,
    )
    .bind(&lower)
    .fetch_optional(&state.db)
    .await?;
    let target = target.ok_or(AppError::NotFound)?;
    sqlx::query(
        r#"INSERT INTO group_members (group_id, account_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (group_id, account_id) DO NOTHING"#,
    )
    .bind(group_id)
    .bind(target)
    .execute(&state.db)
    .await?;
    let members = fetch_member_ids(&state, group_id).await;
    broadcast_groups_changed(&state, &members).await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /groups/:id/members/:user_id — usuń członka. Admin może usunąć
/// kogokolwiek (oprócz siebie jeśli to ostatni admin — wtedy musi delete
/// całą grupę). Każdy może usunąć siebie (leave).
pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((group_id, target)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let is_self = target == user.account_id;
    if !is_self {
        ensure_admin(&state, user.account_id, group_id).await?;
    } else {
        // Sprawdź że jesteś w ogóle członkiem
        let exists: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2)"#,
        )
        .bind(group_id)
        .bind(user.account_id)
        .fetch_one(&state.db)
        .await?;
        if !exists {
            return Err(AppError::NotFound);
        }
    }
    let prev_members = fetch_member_ids(&state, group_id).await;
    sqlx::query(r#"DELETE FROM group_members WHERE group_id = $1 AND account_id = $2"#)
        .bind(group_id)
        .bind(target)
        .execute(&state.db)
        .await?;
    // Broadcast do poprzedniego setu — wszyscy (włącznie z usuwanym) widzą zmianę
    broadcast_groups_changed(&state, &prev_members).await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /groups/:id — usuń grupę. Admin only. Kaskaduje członków i wiadomości.
pub async fn delete_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path(group_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    ensure_admin(&state, user.account_id, group_id).await?;
    let members = fetch_member_ids(&state, group_id).await;
    sqlx::query(r#"DELETE FROM groups WHERE id = $1"#)
        .bind(group_id)
        .execute(&state.db)
        .await?;
    broadcast_groups_changed(&state, &members).await;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /groups — lista moich grup.
pub async fn list_groups(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<GroupSummary>>> {
    let rows: Vec<GroupSummary> = sqlx::query_as(
        r#"
        SELECT g.id, g.name, g.created_by, g.created_at,
               m.role AS my_role,
               (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
        FROM groups g
        JOIN group_members m ON m.group_id = g.id AND m.account_id = $1
        ORDER BY g.created_at DESC
        "#,
    )
    .bind(user.account_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// GET /groups/:id/members — lista członków. Wymaga że jestem członkiem.
pub async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(group_id): Path<Uuid>,
) -> AppResult<Json<Vec<GroupMember>>> {
    ensure_member(&state, user.account_id, group_id).await?;
    let rows: Vec<GroupMember> = sqlx::query_as(
        r#"
        SELECT gm.account_id, a.username, gm.role, gm.joined_at, a.avatar
        FROM group_members gm
        JOIN accounts a ON a.id = gm.account_id
        WHERE gm.group_id = $1
        ORDER BY gm.role DESC, a.username
        "#,
    )
    .bind(group_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct GroupHistoryQuery {
    pub limit: Option<u32>,
    pub before: Option<DateTime<Utc>>,
}

/// GET /groups/:id/history — historia wiadomości w grupie (DESC).
pub async fn group_history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(group_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<GroupHistoryQuery>,
) -> AppResult<Json<Vec<GroupMessage>>> {
    ensure_member(&state, user.account_id, group_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200) as i64;
    let rows: Vec<GroupMessage> = sqlx::query_as(
        r#"
        SELECT gm.id, gm.group_id, gm.sender_id, a.username AS sender_username,
               gm.body, gm.created_at, gm.images
        FROM group_messages gm
        JOIN accounts a ON a.id = gm.sender_id
        WHERE gm.group_id = $1
          AND ($2::timestamptz IS NULL OR gm.created_at < $2)
        ORDER BY gm.created_at DESC
        LIMIT $3
        "#,
    )
    .bind(group_id)
    .bind(q.before)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// Pomocnik: sprawdza że user jest członkiem grupy. NotFound zamiast Forbidden
/// żeby nie wyciekać czy grupa w ogóle istnieje.
pub async fn ensure_member(
    state: &AppState,
    account_id: Uuid,
    group_id: Uuid,
) -> AppResult<()> {
    let is_member: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2)"#,
    )
    .bind(group_id)
    .bind(account_id)
    .fetch_one(&state.db)
    .await?;
    if !is_member {
        return Err(AppError::NotFound);
    }
    Ok(())
}

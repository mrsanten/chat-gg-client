use crate::auth::{extractor::AuthUser, jwt, password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Reguły dla username:
/// - 3..=32 znaki
/// - tylko: a–z, A–Z, 0–9, `_`, `-`, `.`
/// Komparujemy lowercase (case-insensitive), ale w bazie trzymamy original
/// case (do wyświetlania).
fn validate_username(s: &str) -> AppResult<()> {
    let len = s.chars().count();
    if !(3..=32).contains(&len) {
        return Err(AppError::BadRequest("username musi mieć 3-32 znaki".into()));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(AppError::BadRequest(
            "username może zawierać tylko a-z, A-Z, 0-9, _, -, .".into(),
        ));
    }
    Ok(())
}

fn validate_password(s: &str) -> AppResult<()> {
    let len = s.chars().count();
    if !(8..=128).contains(&len) {
        return Err(AppError::BadRequest("hasło musi mieć 8-128 znaków".into()));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct RegisterReq {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginReq {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResp {
    pub token: String,
    pub account: Account,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Account {
    pub id: Uuid,
    pub username: String,
    pub created_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct AccountWithHash {
    id: Uuid,
    username: String,
    password_hash: String,
    created_at: DateTime<Utc>,
}

// ────────────────────────────────────────────────────────────────────────────

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> AppResult<(StatusCode, Json<AuthResp>)> {
    validate_username(&req.username)?;
    validate_password(&req.password)?;

    let username_lower = req.username.to_lowercase();
    let password_hash = password::hash_password(&req.password)?;

    let account: Account = sqlx::query_as(
        r#"
        INSERT INTO accounts (username, username_lower, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, username, created_at
        "#,
    )
    .bind(&req.username)
    .bind(&username_lower)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await?;

    let token = jwt::issue(&state.jwt, account.id, &account.username, state.jwt_ttl)?;

    Ok((
        StatusCode::CREATED,
        Json(AuthResp { token, account }),
    ))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> AppResult<Json<AuthResp>> {
    if req.username.is_empty() || req.password.is_empty() {
        return Err(AppError::BadRequest(
            "username i password są wymagane".into(),
        ));
    }

    let username_lower = req.username.to_lowercase();
    let row: AccountWithHash = sqlx::query_as(
        r#"
        SELECT id, username, password_hash, created_at
        FROM accounts
        WHERE username_lower = $1
        "#,
    )
    .bind(&username_lower)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let ok = password::verify_password(&req.password, &row.password_hash)?;
    if !ok {
        return Err(AppError::Unauthorized);
    }

    let token = jwt::issue(&state.jwt, row.id, &row.username, state.jwt_ttl)?;
    Ok(Json(AuthResp {
        token,
        account: Account {
            id: row.id,
            username: row.username,
            created_at: row.created_at,
        },
    }))
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Account>> {
    let account: Account = sqlx::query_as(
        r#"
        SELECT id, username, created_at
        FROM accounts
        WHERE id = $1
        "#,
    )
    .bind(user.account_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(account))
}

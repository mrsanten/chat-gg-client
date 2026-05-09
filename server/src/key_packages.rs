//! REST endpointy do publikowania i konsumowania KeyPackage'ow MLS.
//!
//! Klient publikuje pakiet (lub kilka) przy rejestracji i potem rotacyjnie.
//! Drugi klient, zaczynajacy z nim rozmowe, pobiera jeden KP — serwer go
//! oznacza `consumed=true`, zeby nie wydac dwa razy. Phase 4 doda device_id
//! (KeyPackage jest per-device, nie per-account).

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct PublishReq {
    /// Lista KeyPackage'ow w base64. Mozna oddac kilka naraz (np. 10) zeby
    /// klient nie musial sie odzywac przy kazdej nowej rozmowie.
    pub packages: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PublishResp {
    pub stored: usize,
    pub total_unconsumed: i64,
}

/// POST /key-packages — body: { packages: [base64,...] }
pub async fn publish(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<PublishReq>,
) -> AppResult<(StatusCode, Json<PublishResp>)> {
    if req.packages.is_empty() {
        return Err(AppError::BadRequest("brak packages".into()));
    }
    if req.packages.len() > 100 {
        return Err(AppError::BadRequest("max 100 packages na jedno wywolanie".into()));
    }

    let mut tx = state.db.begin().await?;
    let mut stored = 0;
    for b64 in &req.packages {
        let bytes = B64
            .decode(b64)
            .map_err(|e| AppError::BadRequest(format!("invalid base64: {e}")))?;
        if bytes.len() < 16 || bytes.len() > 64 * 1024 {
            return Err(AppError::BadRequest("KeyPackage o nieprawdopodobnym rozmiarze".into()));
        }
        sqlx::query(
            r#"INSERT INTO key_packages (account_id, data) VALUES ($1, $2)"#,
        )
        .bind(user.account_id)
        .bind(&bytes)
        .execute(&mut *tx)
        .await?;
        stored += 1;
    }
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM key_packages WHERE account_id = $1 AND NOT consumed"#,
    )
    .bind(user.account_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(PublishResp {
            stored,
            total_unconsumed: total,
        }),
    ))
}

#[derive(Debug, Serialize)]
pub struct ClaimResp {
    pub id: Uuid,
    pub username: String,
    /// KeyPackage w base64 — klient go zdeserializuje przez tls_codec.
    pub data: String,
}

/// GET /key-packages/:username — zwraca jeden niekonsumowany KP danego usera
/// i atomowo oznacza go jako consumed. 404 gdy uzytkownika nie ma; 410 GONE
/// gdy nie ma juz wolnych KP-ow (klient nie ma czego wziac).
pub async fn claim(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(username): Path<String>,
) -> AppResult<Json<ClaimResp>> {
    let username_lower = username.to_lowercase();

    let row: Option<(Uuid, Uuid, String, Vec<u8>)> = sqlx::query_as(
        r#"
        WITH peer AS (
            SELECT id, username FROM accounts WHERE username_lower = $1
        ),
        picked AS (
            SELECT kp.id
            FROM key_packages kp, peer
            WHERE kp.account_id = peer.id AND NOT kp.consumed
            ORDER BY kp.created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE key_packages kp
        SET consumed = TRUE, consumed_at = now()
        FROM picked, peer
        WHERE kp.id = picked.id
        RETURNING kp.id, peer.id AS account_id, peer.username, kp.data
        "#,
    )
    .bind(&username_lower)
    .fetch_optional(&state.db)
    .await?;

    let row = match row {
        Some(r) => r,
        None => {
            // Sprawdzmy, czy user w ogole istnieje, zeby zwrocic precyzyjny status.
            let exists: Option<Uuid> =
                sqlx::query_scalar(r#"SELECT id FROM accounts WHERE username_lower = $1"#)
                    .bind(&username_lower)
                    .fetch_optional(&state.db)
                    .await?;
            if exists.is_none() {
                return Err(AppError::NotFound);
            }
            return Err(AppError::Conflict(
                "uzytkownik nie ma juz wolnych KeyPackage'ow — niech opublikuje nowe".into(),
            ));
        }
    };

    Ok(Json(ClaimResp {
        id: row.0,
        username: row.2,
        data: B64.encode(&row.3),
    }))
}

#[derive(Debug, Serialize)]
pub struct CountResp {
    pub unconsumed: i64,
}

/// GET /key-packages/_count — ile wlasnych KP nie zostalo jeszcze
/// zuzytych. Klient woła to na starcie, zeby zdecydowac, czy uzupelnic
/// pakiety (publish wiecej, gdy zostalo np. <3).
pub async fn my_count(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<CountResp>> {
    let n: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM key_packages WHERE account_id = $1 AND NOT consumed"#,
    )
    .bind(user.account_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(CountResp { unconsumed: n }))
}

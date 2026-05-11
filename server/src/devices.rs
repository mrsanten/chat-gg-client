//! REST endpoints do rejestrowania device tokens dla push notifications.
//!
//! Flow:
//!   1. Klient na iOS rejestruje się przez `registerForRemoteNotifications()`.
//!   2. iOS zwraca device token (hex string ~64 znaki).
//!   3. Klient woła `POST /me/devices` z tokenem + platformą.
//!   4. Server zapisuje w `device_tokens` (upsert).
//!   5. Przy każdej offline message do tego usera, server fan-out-uje APNs
//!      do każdego zapisanego tokenu.
//!
//! Tokeny się rotują (przy reinstalu, restore z backupu, itd.) — klient
//! powinien re-registr-ować przy każdym starcie apki.

use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct RegisterDeviceReq {
    /// Hex device token z iOS / FCM token z Android.
    pub token: String,
    /// "ios" albo "android".
    pub platform: String,
    /// Bundle ID apki, np. "com.mrellwart.gaidugaidu". Pozwala mieć jedno
    /// konto APNs key obsługujące wiele bundle ID-ów (np. dev + prod).
    pub app_bundle_id: String,
    /// "development" (Xcode debug) albo "production" (TestFlight/App Store).
    /// Sandbox APNs vs production APNs to dwa osobne endpointy Apple-a,
    /// musimy wiedzieć którego użyć.
    #[serde(default = "default_env")]
    pub apns_env: String,
}

fn default_env() -> String {
    "production".to_string()
}

/// POST /me/devices — rejestruje (upsert) token push dla zalogowanego usera.
pub async fn register_device(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<RegisterDeviceReq>,
) -> AppResult<StatusCode> {
    if !matches!(req.platform.as_str(), "ios" | "android") {
        return Err(crate::error::AppError::BadRequest(
            "platform musi być 'ios' albo 'android'".into(),
        ));
    }
    if !matches!(req.apns_env.as_str(), "development" | "production") {
        return Err(crate::error::AppError::BadRequest(
            "apns_env musi być 'development' albo 'production'".into(),
        ));
    }
    if req.token.is_empty() || req.token.len() > 200 {
        return Err(crate::error::AppError::BadRequest(
            "token jest wymagany i ma <= 200 znaków".into(),
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO device_tokens (account_id, platform, token, app_bundle_id, apns_env, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (account_id, token) DO UPDATE
        SET platform = EXCLUDED.platform,
            app_bundle_id = EXCLUDED.app_bundle_id,
            apns_env = EXCLUDED.apns_env,
            updated_at = now()
        "#,
    )
    .bind(user.account_id)
    .bind(&req.platform)
    .bind(&req.token)
    .bind(&req.app_bundle_id)
    .bind(&req.apns_env)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /me/devices/{token} — usuwa token (np. przy logout-cie albo
/// user wyłącza push w ustawieniach).
pub async fn unregister_device(
    State(state): State<AppState>,
    user: AuthUser,
    Path(token): Path<String>,
) -> AppResult<StatusCode> {
    sqlx::query(r#"DELETE FROM device_tokens WHERE account_id = $1 AND token = $2"#)
        .bind(user.account_id)
        .bind(&token)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

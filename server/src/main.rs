mod ai_sessions;
mod auth;
mod config;
mod contacts;
mod devices;
mod error;
mod groups;
mod history;
mod hub;
mod key_packages;
mod push;
mod secrets;
mod state;
mod ws;

use anyhow::Context;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Json;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // dotenvy ignoruje brak pliku, więc OK w produkcji.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,gaidu_server=debug,tower_http=info".into()),
        )
        .compact()
        .init();

    let cfg = Config::from_env()?;
    tracing::info!("ładuję konfigurację, BIND_ADDR={}", cfg.bind_addr);

    let state = AppState::from_config(&cfg)
        .await
        .context("nie mogę zainicjować AppState (Postgres niedostępny?)")?;

    let app = axum::Router::new()
        .route("/healthz", get(healthz))
        .route("/auth/register", post(auth::handlers::register))
        .route("/auth/login", post(auth::handlers::login))
        .route("/me", get(auth::handlers::me))
        .route("/me/profile", axum::routing::put(auth::handlers::update_profile))
        .route("/me/avatar", axum::routing::put(auth::handlers::update_avatar))
        .route("/me/devices", axum::routing::post(devices::register_device))
        .route(
            "/me/devices/{token}",
            axum::routing::delete(devices::unregister_device),
        )
        .route(
            "/contacts",
            get(contacts::list_contacts).post(contacts::add_contact),
        )
        .route("/contacts/{peer_id}", axum::routing::delete(contacts::remove_contact))
        .route("/groups", get(groups::list_groups).post(groups::create_group))
        .route(
            "/groups/{id}",
            axum::routing::patch(groups::update_group).delete(groups::delete_group),
        )
        .route(
            "/groups/{id}/members",
            get(groups::list_members).post(groups::add_member),
        )
        .route(
            "/groups/{id}/members/{user_id}",
            axum::routing::delete(groups::remove_member),
        )
        .route("/groups/{id}/history", get(groups::group_history))
        .route("/me/secrets", get(secrets::list_secrets))
        .route(
            "/me/secrets/{provider}",
            axum::routing::put(secrets::upsert_secret),
        )
        .route("/me/sessions", get(ai_sessions::list_sessions))
        .route(
            "/me/sessions/{id}",
            axum::routing::put(ai_sessions::upsert_session)
                .delete(ai_sessions::delete_session),
        )
        .route("/history", get(history::history))
        .route("/key-packages", post(key_packages::publish))
        .route("/key-packages/_count", get(key_packages::my_count))
        .route("/key-packages/{username}", get(key_packages::claim))
        .route("/ws", get(ws::ws_handler))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(
            // Phase 1: pozwalamy każdemu (Tauri webview ma podejrzane originy).
            // W produkcji zawężymy do listy znanych Tauri builds + dev origin.
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr)
        .await
        .with_context(|| format!("nie mogę bindować {}", cfg.bind_addr))?;
    tracing::info!("nasłuchuję na {}", cfg.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serwer padł")?;

    Ok(())
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    // Lekki check: SELECT 1. Jeśli baza padnie, healthz zwróci 503.
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            tracing::warn!("healthz: db down: {e:?}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false, "error": "db" })),
            )
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("Ctrl+C, zamykam"),
        _ = term => tracing::info!("SIGTERM, zamykam"),
    }
}

//! WebSocket protokół: real-time delivery, presence, typing, offline queue.
//!
//! Auth: token JWT w query stringu `?token=<jwt>` (Tauri/przeglądarki nie mają
//! łatwego sposobu wysyłania custom headerów przy upgrade).
//!
//! Po nawiązaniu połączenia serwer:
//!   1. Weryfikuje token, mapuje na account_id.
//!   2. Rejestruje połączenie w hubie. Jeśli to było pierwsze połączenie tego
//!      usera (przejście offline → online), broadcastuje presence do każdego,
//!      kto ma go w kontaktach.
//!   3. Wysyła `ready`.
//!   4. Wysyła wszystkie niedostarczone wiadomości z bazy (offline queue);
//!      każda zostanie oznaczona `delivered_at = now()` w bazie.
//!   5. Pętla: receive `ClientEvent`, fan-out, persist.

use crate::auth::jwt;
use crate::hub::Connection;
use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;
use uuid::Uuid;

// ─────────────────────────────────── Wire types

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    /// Wyślij wiadomość do peera. `client_msg_id` to opcjonalny tymczasowy
    /// id ustawiony przez klienta — pozwala mu skorelować nadchodzącą
    /// `Sent` ze swoją lokalnie zoptymistycznie wstawioną wiadomością.
    Send {
        to: String,
        body: String,
        #[serde(default)]
        client_msg_id: Option<String>,
    },
    /// Status pisania.
    Typing {
        to: String,
        state: TypingState,
    },
    /// Klient potwierdza odebranie wiadomości (do oznaczenia delivered_at).
    AckDelivery { message_id: Uuid },
    /// Pingi heartbeat (klient może wysyłać co 30s).
    Ping,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TypingState {
    Start,
    Stop,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// Po sukcesie auth.
    Ready {
        account_id: Uuid,
        username: String,
    },
    /// Nowa wiadomość przyszła do tego usera.
    Message {
        id: Uuid,
        from: String,
        body: String,
        created_at: DateTime<Utc>,
    },
    /// Echo nadawcy: serwer potwierdza, że wiadomość została zapisana.
    Sent {
        id: Uuid,
        client_msg_id: Option<String>,
        to: String,
        created_at: DateTime<Utc>,
    },
    /// Peer zaczął/skończył pisać.
    Typing {
        from: String,
        state: TypingState,
    },
    /// Status online/offline znajomego.
    Presence {
        username: String,
        online: bool,
    },
    /// Pong na ping.
    Pong,
    /// Błąd na poziomie protokołu (zła komenda, peer nie istnieje, itp.).
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct WsAuth {
    pub token: String,
}

// ─────────────────────────────────── Handler

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(auth): Query<WsAuth>,
) -> axum::response::Response {
    // Weryfikacja JWT przed upgrade — jeśli token zły, odrzucamy z 401
    // zanim w ogóle podniesiemy WS.
    let claims = match jwt::verify(&state.jwt, &auth.token) {
        Ok(c) => c,
        Err(_) => {
            return (axum::http::StatusCode::UNAUTHORIZED, "invalid token").into_response()
        }
    };
    let account_id = match claims.account_id() {
        Ok(id) => id,
        Err(_) => {
            return (axum::http::StatusCode::UNAUTHORIZED, "bad subject").into_response()
        }
    };
    let username = claims.username;

    ws.on_upgrade(move |socket| run_session(socket, state, account_id, username))
}

async fn run_session(socket: WebSocket, state: AppState, account_id: Uuid, username: String) {
    let conn_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<ServerEvent>(128);

    // Zarejestruj w hubie.
    let was_offline = state
        .hub
        .register(
            account_id,
            Connection {
                conn_id,
                username: username.clone(),
                tx: tx.clone(),
            },
        )
        .await;

    // Split socketu na czytanie i pisanie. Send-loop będzie konsumował
    // `rx`, recv-loop bedzie parsował klienta.
    let (mut sink, mut stream) = socket.split();

    // Wyślij ready do nowego połączenia.
    let _ = tx
        .send(ServerEvent::Ready {
            account_id,
            username: username.clone(),
        })
        .await;

    // Push offline queue: wszystko, co nie zostało jeszcze dostarczone.
    if let Err(e) = flush_offline_queue(&state, account_id, &tx).await {
        tracing::warn!("flush_offline_queue: {e:?}");
    }

    // Jeśli właśnie przeszedł offline → online, broadcast presence do
    // każdego, kto ma go w kontaktach.
    if was_offline {
        broadcast_presence(&state, account_id, &username, true).await;
    }

    // ── send-loop: czyta `rx` i wypycha do socketu
    let send_task = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let json = match serde_json::to_string(&ev) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!("serialize ServerEvent: {e:?}");
                    continue;
                }
            };
            if sink.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
        // best-effort close
        let _ = sink.close().await;
    });

    // ── recv-loop: parsuje wejście, persistuje, fan-out
    let state_for_recv = state.clone();
    let username_for_recv = username.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    tracing::debug!("ws recv err: {e:?}");
                    break;
                }
            };
            match msg {
                Message::Text(text) => {
                    let parsed: Result<ClientEvent, _> = serde_json::from_str(&text);
                    match parsed {
                        Ok(ev) => {
                            handle_client_event(
                                &state_for_recv,
                                account_id,
                                &username_for_recv,
                                ev,
                                &tx,
                            )
                            .await;
                        }
                        Err(e) => {
                            let _ = tx
                                .send(ServerEvent::Error {
                                    code: "bad_frame".into(),
                                    message: format!("nieprawidłowy JSON: {e}"),
                                })
                                .await;
                        }
                    }
                }
                Message::Close(_) => break,
                Message::Ping(payload) => {
                    // axum sam odpowie pongiem na ping framework-level, ale na
                    // wszelki wypadek ignorujemy explicite.
                    let _ = payload;
                }
                _ => {}
            }
        }
    });

    // Czekamy aż któryś loop padnie. Jeden koniec = zamykamy oba.
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    // Cleanup. Jeśli to ostatnie połączenie tego usera, broadcast offline.
    let now_offline = state.hub.unregister(account_id, conn_id).await;
    if now_offline {
        broadcast_presence(&state, account_id, &username, false).await;
    }
}

async fn handle_client_event(
    state: &AppState,
    sender_id: Uuid,
    sender_username: &str,
    ev: ClientEvent,
    tx: &mpsc::Sender<ServerEvent>,
) {
    match ev {
        ClientEvent::Ping => {
            let _ = tx.send(ServerEvent::Pong).await;
        }
        ClientEvent::AckDelivery { message_id } => {
            // Best-effort, ignore błędu (klient może retransmitować ack).
            if let Err(e) = sqlx::query(
                r#"UPDATE messages
                   SET delivered_at = now()
                   WHERE id = $1 AND recipient_id = $2 AND delivered_at IS NULL"#,
            )
            .bind(message_id)
            .bind(sender_id)
            .execute(&state.db)
            .await
            {
                tracing::warn!("ack_delivery update: {e:?}");
            }
        }
        ClientEvent::Typing { to, state: ts } => {
            // Resolve peer id z usernamea. Jeśli go nie ma — milcząco ignoruj.
            let peer_lower = to.to_lowercase();
            let peer_id: Option<Uuid> =
                sqlx::query_scalar(r#"SELECT id FROM accounts WHERE username_lower = $1"#)
                    .bind(&peer_lower)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten();
            if let Some(peer_id) = peer_id {
                state
                    .hub
                    .send_to(
                        peer_id,
                        ServerEvent::Typing {
                            from: sender_username.to_string(),
                            state: ts,
                        },
                    )
                    .await;
            }
        }
        ClientEvent::Send {
            to,
            body,
            client_msg_id,
        } => {
            if body.is_empty() {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "empty_body".into(),
                        message: "wiadomość nie może być pusta".into(),
                    })
                    .await;
                return;
            }
            if body.len() > 64 * 1024 {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "body_too_large".into(),
                        message: "wiadomość większa niż 64 KiB".into(),
                    })
                    .await;
                return;
            }
            let peer_lower = to.to_lowercase();
            let peer: Option<(Uuid, String)> = sqlx::query_as(
                r#"SELECT id, username FROM accounts WHERE username_lower = $1"#,
            )
            .bind(&peer_lower)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
            let Some((peer_id, peer_username)) = peer else {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "peer_not_found".into(),
                        message: format!("user '{to}' nie istnieje"),
                    })
                    .await;
                return;
            };
            if peer_id == sender_id {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "self_send".into(),
                        message: "nie można wysłać wiadomości do siebie".into(),
                    })
                    .await;
                return;
            }

            let inserted: Result<(Uuid, DateTime<Utc>), sqlx::Error> = sqlx::query_as(
                r#"
                INSERT INTO messages (sender_id, recipient_id, body)
                VALUES ($1, $2, $3)
                RETURNING id, created_at
                "#,
            )
            .bind(sender_id)
            .bind(peer_id)
            .bind(&body)
            .fetch_one(&state.db)
            .await;

            let (msg_id, created_at) = match inserted {
                Ok(x) => x,
                Err(e) => {
                    tracing::error!("insert message: {e:?}");
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "db".into(),
                            message: "nie udało się zapisać wiadomości".into(),
                        })
                        .await;
                    return;
                }
            };

            // Echo do nadawcy ("Sent") — wszystkie jego device dostają sygnał
            // że wiadomość poszła. Lokalnie zoptymistyczny render może teraz
            // zatwierdzić tymczasowy id.
            state
                .hub
                .send_to(
                    sender_id,
                    ServerEvent::Sent {
                        id: msg_id,
                        client_msg_id: client_msg_id.clone(),
                        to: peer_username.clone(),
                        created_at,
                    },
                )
                .await;

            // Doręczenie. Jeśli peer offline, zostawiamy w bazie z
            // delivered_at IS NULL.
            if state.hub.is_online(peer_id).await {
                state
                    .hub
                    .send_to(
                        peer_id,
                        ServerEvent::Message {
                            id: msg_id,
                            from: sender_username.to_string(),
                            body,
                            created_at,
                        },
                    )
                    .await;
                // Optymistycznie oznaczamy delivered. Klient i tak ack'nie
                // ponownie po odbiorze, idempotentnie.
                let _ = sqlx::query(
                    r#"UPDATE messages SET delivered_at = now()
                       WHERE id = $1 AND delivered_at IS NULL"#,
                )
                .bind(msg_id)
                .execute(&state.db)
                .await;
            }
        }
    }
}

async fn flush_offline_queue(
    state: &AppState,
    account_id: Uuid,
    tx: &mpsc::Sender<ServerEvent>,
) -> anyhow::Result<()> {
    // FIFO: oldest first.
    let rows: Vec<(Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT m.id, a.username, m.body, m.created_at
        FROM messages m
        JOIN accounts a ON a.id = m.sender_id
        WHERE m.recipient_id = $1 AND m.delivered_at IS NULL
        ORDER BY m.created_at ASC
        "#,
    )
    .bind(account_id)
    .fetch_all(&state.db)
    .await?;

    for (id, from, body, created_at) in rows {
        // Jeśli send nie powiedzie się (klient się rozłączył), kończymy.
        if tx
            .send(ServerEvent::Message {
                id,
                from,
                body,
                created_at,
            })
            .await
            .is_err()
        {
            break;
        }
        // Oznaczamy delivered. Klient i tak ack'nie własnym frame'em,
        // ale my chcemy zapobiec dwukrotnemu wypchnięciu jeśli zaraz po
        // tym przyjdzie reconnect.
        let _ = sqlx::query(
            r#"UPDATE messages SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL"#,
        )
        .bind(id)
        .execute(&state.db)
        .await;
    }
    Ok(())
}

async fn broadcast_presence(state: &AppState, account_id: Uuid, username: &str, online: bool) {
    // Pobierz listę kontaktów, których trzeba poinformować
    // (czyli wszystkich userów, co mają mnie w kontaktach == owner_id).
    let watchers: Vec<Uuid> = sqlx::query_scalar(
        r#"SELECT owner_id FROM contacts WHERE peer_id = $1"#,
    )
    .bind(account_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let event = ServerEvent::Presence {
        username: username.to_string(),
        online,
    };
    for w in watchers {
        state.hub.send_to(w, event.clone()).await;
    }
}

// Hint dla compilera: kompilacja powinna być świadoma, że Duration jest used
// (dla future use w heartbeacie, którego jeszcze nie skompletowaliśmy).
#[allow(dead_code)]
const _PING_INTERVAL: Duration = Duration::from_secs(30);

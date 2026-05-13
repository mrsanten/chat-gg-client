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
use crate::hub::{Connection, Status};
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
    /// Klient potwierdza odebranie zaszyfrowanego bloba (MLS application msg).
    AckBlob { blob_id: Uuid },
    /// Klient potwierdza odebranie Welcome (= zjoinowanie grupy MLS).
    AckWelcome { welcome_id: Uuid },
    /// Wyślij zaszyfrowany Application Message MLS do peera. group_id+epoch
    /// trzymane plain (do routingu i detekcji desync); ciphertext nieprzezroczysty.
    SendBlob {
        to: String,
        group_id: String, // base64
        epoch: i64,
        ciphertext: String, // base64 (MLS PrivateMessage)
        #[serde(default)]
        client_msg_id: Option<String>,
    },
    /// Wyślij Welcome do nowego członka grupy (zwykle pierwsza interakcja).
    SendWelcome {
        to: String,
        ciphertext: String, // base64 (MLS Welcome)
    },
    /// Pingi heartbeat (klient może wysyłać co 30s).
    Ping,
    /// Klient ustawia własny status presence (online / afk).
    /// Server broadcastuje peerom przez `Presence`.
    SetStatus { status: Status },
    /// Wyślij wiadomość do grupy (wszyscy członkowie dostają fan-out).
    SendGroupMessage {
        group_id: Uuid,
        body: String,
        #[serde(default)]
        client_msg_id: Option<String>,
    },
    /// Typing indicator w grupie. Fan-out do wszystkich członków oprócz nadawcy.
    TypingGroup {
        group_id: Uuid,
        state: TypingState,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TypingState {
    Start,
    Stop,
}

/// Wire-level status presence dla peerów.
/// - `Online` = aktywny WS connection (jakiekolwiek urządzenie)
/// - `Afk` = WS connected ale klient sam się oznaczył jako AFK
/// - `PushReachable` = brak WS, ale ma zarejestrowany push token — peer może
///   wysłać wiadomość, dotrze przez APNs. Klient nowy renderuje default
///   sprite; stary klient (bez tego pola w protokole) traktuje `online=false`
///   jako offline (bezpieczny fallback).
/// - `Offline` = brak WS i brak push tokenów.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStatus {
    Online,
    Afk,
    PushReachable,
    Offline,
}

impl From<Status> for PresenceStatus {
    fn from(s: Status) -> Self {
        match s {
            Status::Online => PresenceStatus::Online,
            Status::Afk => PresenceStatus::Afk,
        }
    }
}

/// Liczy aktualny presence usera: priorytet WS > push_reachable > offline.
/// - Każde online WS connection (jakiekolwiek urządzenie) → Online (lub Afk
///   jeśli user sam ustawił).
/// - Bez WS, ale ma w `device_tokens` choć jeden rekord → PushReachable.
/// - Inaczej → Offline.
///
/// Wynik to (`online_bool_legacy`, `status`). `online_bool` jest TRUE tylko
/// dla rzeczywistego WS — stary klient (sprzed PushReachable) widzi push
/// users jako offline, co jest bezpieczne (i tak nie umie renderować
/// PushReachable). Nowy klient czyta `status` i renderuje default sprite.
pub async fn derive_presence(
    state: &crate::state::AppState,
    account_id: Uuid,
) -> (bool, PresenceStatus) {
    if let Some(s) = state.hub.get_status(account_id).await {
        return (true, s.into());
    }
    let has_token: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM device_tokens WHERE account_id = $1)"#,
    )
    .bind(account_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);
    if has_token {
        (false, PresenceStatus::PushReachable)
    } else {
        (false, PresenceStatus::Offline)
    }
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
    /// `body` od v0.13.2 — pozwala innym urządzeniom tego samego usera
    /// zsynchronizować outgoing message na żywo (multi-device sync).
    Sent {
        id: Uuid,
        client_msg_id: Option<String>,
        to: String,
        body: String,
        created_at: DateTime<Utc>,
    },
    /// Peer zaczął/skończył pisać.
    Typing {
        from: String,
        state: TypingState,
    },
    /// Status presence znajomego: online/afk/offline. `online` zostawiamy dla
    /// kompatybilności z klientami sprzed v0.13 (pre-AFK), nowy klient czyta
    /// `status`.
    Presence {
        username: String,
        online: bool,
        status: PresenceStatus,
    },
    /// Zaszyfrowana wiadomość MLS przyszła do tego usera.
    Blob {
        id: Uuid,
        from: String,
        group_id: String,    // base64
        epoch: i64,
        ciphertext: String,  // base64
        created_at: DateTime<Utc>,
    },
    /// Echo nadawcy bloba — analog Sent dla MLS.
    SentBlob {
        id: Uuid,
        client_msg_id: Option<String>,
        to: String,
        created_at: DateTime<Utc>,
    },
    /// Welcome do nowej grupy MLS przyszło.
    Welcome {
        id: Uuid,
        from: String,
        ciphertext: String,  // base64
        created_at: DateTime<Utc>,
    },
    /// Nowa wiadomość w grupie — przyszła do tego członka.
    GroupMessage {
        id: Uuid,
        group_id: Uuid,
        from: String,
        body: String,
        created_at: DateTime<Utc>,
    },
    /// Echo nadawcy wiadomości grupowej — analog `Sent` dla peer chat.
    SentGroup {
        id: Uuid,
        group_id: Uuid,
        client_msg_id: Option<String>,
        body: String,
        created_at: DateTime<Utc>,
    },
    /// Lista kontaktów się zmieniła (add/remove). Klient powinien wywołać
    /// GET /contacts żeby zassać świeży stan.
    ContactsChanged,
    /// Lista grup / członkostwo / nazwa się zmieniły. Klient wywoła
    /// GET /groups i ewentualnie /groups/:id/members.
    GroupsChanged,
    /// Typing indicator w grupie (analog Typing dla peer chat).
    GroupTyping {
        group_id: Uuid,
        from: String,
        state: TypingState,
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

    // Jeśli właśnie przeszedł z (offline / push_reachable) → online, broadcast
    // presence do każdego, kto ma go w kontaktach. Świeży login zawsze
    // startuje od Online (AFK reset w hub::unregister).
    if was_offline {
        let (online, status) = derive_presence(&state, account_id).await;
        broadcast_presence(&state, account_id, &username, online, status).await;
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

    // Cleanup. Jeśli to ostatnie połączenie tego usera, broadcast nowy
    // status — `Offline` jeśli nie ma push tokenów, albo `PushReachable`
    // jeśli ma (mobile app w tle ale można jeszcze dorwać przez APNs).
    let now_offline = state.hub.unregister(account_id, conn_id).await;
    if now_offline {
        let (online, status) = derive_presence(&state, account_id).await;
        broadcast_presence(&state, account_id, &username, online, status).await;
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
        ClientEvent::SetStatus { status } => {
            // Aktualizuj hub. Jeśli się zmienił, broadcast peerom.
            if let Some(new_status) = state.hub.set_status(sender_id, status).await {
                broadcast_presence(
                    state,
                    sender_id,
                    sender_username,
                    true,
                    new_status.into(),
                )
                .await;
            }
        }
        ClientEvent::SendGroupMessage {
            group_id,
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
            // Sprawdź że nadawca jest członkiem grupy
            let is_member: bool = sqlx::query_scalar(
                r#"SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2)"#,
            )
            .bind(group_id)
            .bind(sender_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);
            if !is_member {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "not_member".into(),
                        message: "nie jesteś członkiem tej grupy".into(),
                    })
                    .await;
                return;
            }
            // Insert
            let inserted: Result<(Uuid, DateTime<Utc>), sqlx::Error> = sqlx::query_as(
                r#"
                INSERT INTO group_messages (group_id, sender_id, body)
                VALUES ($1, $2, $3)
                RETURNING id, created_at
                "#,
            )
            .bind(group_id)
            .bind(sender_id)
            .bind(&body)
            .fetch_one(&state.db)
            .await;
            let (msg_id, created_at) = match inserted {
                Ok(x) => x,
                Err(e) => {
                    tracing::error!("insert group_message: {e:?}");
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "db".into(),
                            message: "nie udało się zapisać wiadomości".into(),
                        })
                        .await;
                    return;
                }
            };
            // Echo do nadawcy (wszystkie jego device-y)
            state
                .hub
                .send_to(
                    sender_id,
                    ServerEvent::SentGroup {
                        id: msg_id,
                        group_id,
                        client_msg_id: client_msg_id.clone(),
                        body: body.clone(),
                        created_at,
                    },
                )
                .await;
            // Pobierz członków (oprócz nadawcy) i fan-out
            let member_ids: Vec<Uuid> = sqlx::query_scalar(
                r#"SELECT account_id FROM group_members
                   WHERE group_id = $1 AND account_id <> $2"#,
            )
            .bind(group_id)
            .bind(sender_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
            for member_id in &member_ids {
                state
                    .hub
                    .send_to(
                        *member_id,
                        ServerEvent::GroupMessage {
                            id: msg_id,
                            group_id,
                            from: sender_username.to_string(),
                            body: body.clone(),
                            created_at,
                        },
                    )
                    .await;
            }
            // Push do offline członków (jak peer message, best-effort)
            if let Some(push) = state.push.clone() {
                let db = state.db.clone();
                let from = sender_username.to_string();
                let preview = body.clone();
                let offline_members: Vec<Uuid> = {
                    let mut out = Vec::new();
                    for m in &member_ids {
                        if !state.hub.is_online(*m).await {
                            out.push(*m);
                        }
                    }
                    out
                };
                let push_clone = push.clone();
                tokio::spawn(async move {
                    for recipient in offline_members {
                        push_clone
                            .send_message_to(&db, recipient, &from, &preview, 0)
                            .await;
                    }
                });
            }
        }
        ClientEvent::TypingGroup { group_id, state: ts } => {
            // Sprawdź członkostwo + fan-out do wszystkich oprócz nadawcy.
            let members: Vec<Uuid> = sqlx::query_scalar(
                r#"SELECT account_id FROM group_members
                   WHERE group_id = $1 AND account_id <> $2"#,
            )
            .bind(group_id)
            .bind(sender_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
            for m in members {
                state
                    .hub
                    .send_to(
                        m,
                        ServerEvent::GroupTyping {
                            group_id,
                            from: sender_username.to_string(),
                            state: ts.clone(),
                        },
                    )
                    .await;
            }
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
        ClientEvent::AckBlob { blob_id } => {
            if let Err(e) = sqlx::query(
                r#"UPDATE message_blobs
                   SET delivered_at = now()
                   WHERE id = $1 AND recipient_id = $2 AND delivered_at IS NULL"#,
            )
            .bind(blob_id)
            .bind(sender_id)
            .execute(&state.db)
            .await
            {
                tracing::warn!("ack_blob update: {e:?}");
            }
        }
        ClientEvent::AckWelcome { welcome_id } => {
            if let Err(e) = sqlx::query(
                r#"UPDATE welcomes
                   SET delivered_at = now()
                   WHERE id = $1 AND recipient_id = $2 AND delivered_at IS NULL"#,
            )
            .bind(welcome_id)
            .bind(sender_id)
            .execute(&state.db)
            .await
            {
                tracing::warn!("ack_welcome update: {e:?}");
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
        ClientEvent::SendBlob {
            to,
            group_id,
            epoch,
            ciphertext,
            client_msg_id,
        } => {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            let group_bytes = match B64.decode(&group_id) {
                Ok(b) => b,
                Err(_) => {
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "bad_group_id".into(),
                            message: "group_id musi być base64".into(),
                        })
                        .await;
                    return;
                }
            };
            let cipher_bytes = match B64.decode(&ciphertext) {
                Ok(b) => b,
                Err(_) => {
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "bad_ciphertext".into(),
                            message: "ciphertext musi być base64".into(),
                        })
                        .await;
                    return;
                }
            };
            if cipher_bytes.len() > 256 * 1024 {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "blob_too_large".into(),
                        message: "ciphertext > 256 KiB".into(),
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
                        message: "nie można wysłać do siebie".into(),
                    })
                    .await;
                return;
            }

            let inserted: Result<(Uuid, DateTime<Utc>), sqlx::Error> = sqlx::query_as(
                r#"
                INSERT INTO message_blobs (sender_id, recipient_id, group_id, epoch, ciphertext)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, created_at
                "#,
            )
            .bind(sender_id)
            .bind(peer_id)
            .bind(&group_bytes)
            .bind(epoch)
            .bind(&cipher_bytes)
            .fetch_one(&state.db)
            .await;
            let (blob_id, created_at) = match inserted {
                Ok(x) => x,
                Err(e) => {
                    tracing::error!("insert blob: {e:?}");
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "db".into(),
                            message: "nie udało się zapisać bloba".into(),
                        })
                        .await;
                    return;
                }
            };

            // Echo nadawcy.
            state
                .hub
                .send_to(
                    sender_id,
                    ServerEvent::SentBlob {
                        id: blob_id,
                        client_msg_id: client_msg_id.clone(),
                        to: peer_username,
                        created_at,
                    },
                )
                .await;

            // Doręczenie peerowi (jeśli online). Offline trafi przy reconnect.
            if state.hub.is_online(peer_id).await {
                state
                    .hub
                    .send_to(
                        peer_id,
                        ServerEvent::Blob {
                            id: blob_id,
                            from: sender_username.to_string(),
                            group_id,
                            epoch,
                            ciphertext,
                            created_at,
                        },
                    )
                    .await;
                let _ = sqlx::query(
                    r#"UPDATE message_blobs SET delivered_at = now()
                       WHERE id = $1 AND delivered_at IS NULL"#,
                )
                .bind(blob_id)
                .execute(&state.db)
                .await;
            }
        }
        ClientEvent::SendWelcome { to, ciphertext } => {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            let cipher_bytes = match B64.decode(&ciphertext) {
                Ok(b) => b,
                Err(_) => {
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "bad_ciphertext".into(),
                            message: "ciphertext musi być base64".into(),
                        })
                        .await;
                    return;
                }
            };
            if cipher_bytes.len() > 256 * 1024 {
                let _ = tx
                    .send(ServerEvent::Error {
                        code: "welcome_too_large".into(),
                        message: "Welcome > 256 KiB".into(),
                    })
                    .await;
                return;
            }
            let peer_lower = to.to_lowercase();
            let peer_id: Option<Uuid> =
                sqlx::query_scalar(r#"SELECT id FROM accounts WHERE username_lower = $1"#)
                    .bind(&peer_lower)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten();
            let Some(peer_id) = peer_id else {
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
                        code: "self_welcome".into(),
                        message: "nie można wysłać Welcome do siebie".into(),
                    })
                    .await;
                return;
            }
            let inserted: Result<(Uuid, DateTime<Utc>), sqlx::Error> = sqlx::query_as(
                r#"
                INSERT INTO welcomes (recipient_id, sender_id, ciphertext)
                VALUES ($1, $2, $3)
                RETURNING id, created_at
                "#,
            )
            .bind(peer_id)
            .bind(sender_id)
            .bind(&cipher_bytes)
            .fetch_one(&state.db)
            .await;
            let (welcome_id, created_at) = match inserted {
                Ok(x) => x,
                Err(e) => {
                    tracing::error!("insert welcome: {e:?}");
                    let _ = tx
                        .send(ServerEvent::Error {
                            code: "db".into(),
                            message: "nie udało się zapisać Welcome".into(),
                        })
                        .await;
                    return;
                }
            };
            if state.hub.is_online(peer_id).await {
                state
                    .hub
                    .send_to(
                        peer_id,
                        ServerEvent::Welcome {
                            id: welcome_id,
                            from: sender_username.to_string(),
                            ciphertext,
                            created_at,
                        },
                    )
                    .await;
                let _ = sqlx::query(
                    r#"UPDATE welcomes SET delivered_at = now()
                       WHERE id = $1 AND delivered_at IS NULL"#,
                )
                .bind(welcome_id)
                .execute(&state.db)
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
            // zatwierdzić tymczasowy id. Body jest też tutaj, żeby drugie
            // urządzenie tego samego usera (które nie ma tmp-id) mogło je
            // dorzucić do listy (multi-device sync outgoing).
            state
                .hub
                .send_to(
                    sender_id,
                    ServerEvent::Sent {
                        id: msg_id,
                        client_msg_id: client_msg_id.clone(),
                        to: peer_username.clone(),
                        body: body.clone(),
                        created_at,
                    },
                )
                .await;

            // Doręczenie. Jeśli peer offline, zostawiamy w bazie z
            // delivered_at IS NULL i odpalamy push notification do jego
            // urządzeń (jeśli APNs jest skonfigurowane i token zarejestrowany).
            let peer_online = state.hub.is_online(peer_id).await;
            if !peer_online {
                if let Some(push) = state.push.clone() {
                    let db = state.db.clone();
                    let from = sender_username.to_string();
                    let body_preview = body.clone();
                    let recipient = peer_id;
                    // Spawn — push to fire-and-forget, nie blokuje
                    // WS handler-a (Apple HTTP/2 może mieć kilka ms RTT).
                    tokio::spawn(async move {
                        let unread = count_unread(&db, recipient).await;
                        push
                            .send_message_to(&db, recipient, &from, &body_preview, unread)
                            .await;
                    });
                }
            }
            if peer_online {
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
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    // 1) Welcomes — najpierw, bo bez Welcome nie da się rozszyfrować bloba.
    let welcomes: Vec<(Uuid, String, Vec<u8>, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT w.id, a.username, w.ciphertext, w.created_at
        FROM welcomes w
        JOIN accounts a ON a.id = w.sender_id
        WHERE w.recipient_id = $1 AND w.delivered_at IS NULL
        ORDER BY w.created_at ASC
        "#,
    )
    .bind(account_id)
    .fetch_all(&state.db)
    .await?;
    for (id, from, ciphertext, created_at) in welcomes {
        if tx
            .send(ServerEvent::Welcome {
                id,
                from,
                ciphertext: B64.encode(&ciphertext),
                created_at,
            })
            .await
            .is_err()
        {
            return Ok(());
        }
        let _ = sqlx::query(
            r#"UPDATE welcomes SET delivered_at = now()
               WHERE id = $1 AND delivered_at IS NULL"#,
        )
        .bind(id)
        .execute(&state.db)
        .await;
    }

    // 2) Zaszyfrowane blob-y MLS — kolejność po created_at, klient sobie
    // dopasuje per-grupa po (group_id, epoch).
    let blobs: Vec<(Uuid, String, Vec<u8>, i64, Vec<u8>, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT mb.id, a.username, mb.group_id, mb.epoch, mb.ciphertext, mb.created_at
        FROM message_blobs mb
        JOIN accounts a ON a.id = mb.sender_id
        WHERE mb.recipient_id = $1 AND mb.delivered_at IS NULL
        ORDER BY mb.created_at ASC
        "#,
    )
    .bind(account_id)
    .fetch_all(&state.db)
    .await?;
    for (id, from, group_id, epoch, ciphertext, created_at) in blobs {
        if tx
            .send(ServerEvent::Blob {
                id,
                from,
                group_id: B64.encode(&group_id),
                epoch,
                ciphertext: B64.encode(&ciphertext),
                created_at,
            })
            .await
            .is_err()
        {
            return Ok(());
        }
        let _ = sqlx::query(
            r#"UPDATE message_blobs SET delivered_at = now()
               WHERE id = $1 AND delivered_at IS NULL"#,
        )
        .bind(id)
        .execute(&state.db)
        .await;
    }

    // 3) Plain text messages (legacy z phase 2 — zostają dla starych konwersacji).
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
        let _ = sqlx::query(
            r#"UPDATE messages SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL"#,
        )
        .bind(id)
        .execute(&state.db)
        .await;
    }
    Ok(())
}

pub async fn broadcast_presence(
    state: &AppState,
    account_id: Uuid,
    username: &str,
    online: bool,
    status: PresenceStatus,
) {
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
        status,
    };
    for w in watchers {
        state.hub.send_to(w, event.clone()).await;
    }
}

// Hint dla compilera: kompilacja powinna być świadoma, że Duration jest used
// (dla future use w heartbeacie, którego jeszcze nie skompletowaliśmy).
#[allow(dead_code)]
const _PING_INTERVAL: Duration = Duration::from_secs(30);

/// Liczba niedoręczonych wiadomości do tego usera (plain + blob). Idzie do
/// APNs payload jako badge count nad ikoną apki na iPhone-ie. Best-effort —
/// błąd db = zero (zamiast crashować push).
async fn count_unread(db: &sqlx::PgPool, recipient_id: Uuid) -> i64 {
    let plain: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM messages
           WHERE recipient_id = $1 AND delivered_at IS NULL"#,
    )
    .bind(recipient_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);
    let blob: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM message_blobs
           WHERE recipient_id = $1 AND delivered_at IS NULL"#,
    )
    .bind(recipient_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);
    plain + blob
}

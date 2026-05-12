//! APNs (Apple Push Notification service) integration.
//!
//! Wykorzystuje crate `a2` — HTTP/2 client do Apple. Auth przez .p8 key
//! (Token Authentication, nie certyfikatowy). Każdy `send_to_user` próbuje
//! wysłać do każdego device-tokena tego usera, błędy logowane ale nie
//! propagowane (push to best-effort, nie blokuje persist message-a).

use crate::config::{ApnsConfig, ApnsEnv};
use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, ErrorReason,
    NotificationBuilder, NotificationOptions, Priority, PushType, Response,
};
use sqlx::PgPool;
use std::fs::File;
use uuid::Uuid;

#[derive(Clone)]
pub struct PushClient {
    inner: std::sync::Arc<Client>,
    bundle_id: String,
}

impl PushClient {
    pub fn from_config(cfg: &ApnsConfig) -> anyhow::Result<Self> {
        let mut key_file = File::open(&cfg.key_path).map_err(|e| {
            anyhow::anyhow!("nie mogę otworzyć APNS_KEY_PATH ({}): {}", cfg.key_path, e)
        })?;
        let endpoint = match cfg.environment {
            ApnsEnv::Development => Endpoint::Sandbox,
            ApnsEnv::Production => Endpoint::Production,
        };
        let client = Client::token(
            &mut key_file,
            &cfg.key_id,
            &cfg.team_id,
            ClientConfig::new(endpoint),
        )
        .map_err(|e| anyhow::anyhow!("nie mogę zbudować APNs client: {}", e))?;
        tracing::info!(
            "APNs initialized: env={:?}, bundle_id={}, key_id={}",
            cfg.environment,
            cfg.bundle_id,
            cfg.key_id
        );
        Ok(Self {
            inner: std::sync::Arc::new(client),
            bundle_id: cfg.bundle_id.clone(),
        })
    }

    /// Wyślij wiadomość-push do każdego device-tokenu tego usera (iOS only;
    /// Android FCM kiedyś dorzucimy). Nieaktualne tokeny (410 z APNs)
    /// usuwamy z bazy, żeby nie spamić przyszłych wysyłek.
    pub async fn send_message_to(
        &self,
        db: &PgPool,
        recipient_id: Uuid,
        from_username: &str,
        body_preview: &str,
        unread_total: i64,
    ) {
        let tokens: Vec<(String, String)> = match sqlx::query_as(
            r#"SELECT token, apns_env FROM device_tokens
               WHERE account_id = $1 AND platform = 'ios'"#,
        )
        .bind(recipient_id)
        .fetch_all(db)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("push: load tokens failed: {e:?}");
                return;
            }
        };

        if tokens.is_empty() {
            return;
        }

        // APNs limit body ~4 KB, ale dobrym tonem jest trzymać preview krótki
        // (banner i tak skraca). Capujemy na 120 znaków.
        let preview = truncate(body_preview, 120);
        let badge = if unread_total > 0 && unread_total < 99 {
            Some(unread_total as u32)
        } else if unread_total >= 99 {
            Some(99)
        } else {
            None
        };

        for (token, _env) in &tokens {
            // Custom sound: plik musi być w app bundle (Tauri kopiuje przez
            // bundle.resources w tauri.conf.json). Apple szuka po nazwie
            // pliku w mainBundle. Format CAF/AIFF/WAV (nie MP3), max 30s.
            let builder = DefaultNotificationBuilder::new()
                .set_title(from_username)
                .set_body(&preview)
                .set_sound("notify.caf")
                .set_mutable_content();
            let mut payload = builder.build(
                token,
                NotificationOptions {
                    apns_topic: Some(&self.bundle_id),
                    apns_priority: Some(Priority::High),
                    apns_push_type: Some(PushType::Alert),
                    ..Default::default()
                },
            );
            if let Some(b) = badge {
                // a2 0.10: aps to struct (nie Option), ustawiamy bezpośrednio.
                payload.aps.badge = Some(b);
            }
            // Custom data — `peer` to username nadawcy. Native iOS handler
            // czyta to przy tapie notyfikacji i otwiera odpowiednią
            // konwersację (deep-link).
            let _ = payload.add_custom_data("peer", &serde_json::json!(from_username));

            match self.inner.send(payload).await {
                Ok(resp) if resp.code == 200 => {
                    tracing::debug!("APNs sent OK to ...{}", short_token(token));
                }
                Ok(resp) => {
                    // ErrorReason w a2 0.10 nie ma Clone; matchujemy
                    // przez referencję żeby uniknąć move-a z Option.
                    let stale = match &resp.error {
                        Some(e) => matches!(
                            e.reason,
                            ErrorReason::BadDeviceToken
                                | ErrorReason::Unregistered
                                | ErrorReason::DeviceTokenNotForTopic
                        ),
                        None => false,
                    };
                    tracing::warn!(
                        "APNs response code={} error={:?} for ...{}",
                        resp.code,
                        resp.error,
                        short_token(token)
                    );
                    if stale {
                        // Token nieważny — wyczyść z bazy.
                        let _ = sqlx::query(
                            r#"DELETE FROM device_tokens
                               WHERE account_id = $1 AND token = $2"#,
                        )
                        .bind(recipient_id)
                        .bind(token)
                        .execute(db)
                        .await;
                        tracing::info!(
                            "APNs deleted stale token ...{} for user {}",
                            short_token(token),
                            recipient_id
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "APNs send failed for ...{}: {e:?}",
                        short_token(token)
                    );
                }
            }
        }
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

fn short_token(token: &str) -> &str {
    let len = token.len();
    if len > 8 {
        &token[len - 8..]
    } else {
        token
    }
}

use crate::config::Config;
use crate::hub::Hub;
use crate::push::PushClient;
use jsonwebtoken::{DecodingKey, EncodingKey};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;

/// Stan współdzielony między handlerami.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub jwt: JwtKeys,
    pub jwt_ttl: Duration,
    pub hub: Hub,
    /// Push notifications. None gdy APNs config niekompletny — push skipowany,
    /// reszta serwera działa normalnie.
    pub push: Option<PushClient>,
}

#[derive(Clone)]
pub struct JwtKeys {
    pub encoding: Arc<EncodingKey>,
    pub decoding: Arc<DecodingKey>,
}

impl JwtKeys {
    pub fn from_secret(secret: &str) -> Self {
        Self {
            encoding: Arc::new(EncodingKey::from_secret(secret.as_bytes())),
            decoding: Arc::new(DecodingKey::from_secret(secret.as_bytes())),
        }
    }
}

impl AppState {
    pub async fn from_config(cfg: &Config) -> anyhow::Result<Self> {
        let db = PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&cfg.database_url)
            .await?;
        sqlx::migrate!().run(&db).await?;
        let push = match &cfg.apns {
            Some(apns_cfg) => match PushClient::from_config(apns_cfg) {
                Ok(c) => Some(c),
                Err(e) => {
                    tracing::warn!(
                        "APNs init failed (push notifications disabled): {e:?}"
                    );
                    None
                }
            },
            None => {
                tracing::info!("APNs not configured (set APNS_KEY_PATH etc. żeby włączyć push)");
                None
            }
        };
        Ok(Self {
            db,
            jwt: JwtKeys::from_secret(&cfg.jwt_secret),
            jwt_ttl: cfg.jwt_ttl,
            hub: Hub::new(),
            push,
        })
    }
}

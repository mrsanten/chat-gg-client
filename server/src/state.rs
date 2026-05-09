use crate::config::Config;
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
        Ok(Self {
            db,
            jwt: JwtKeys::from_secret(&cfg.jwt_secret),
            jwt_ttl: cfg.jwt_ttl,
        })
    }
}

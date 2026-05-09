use anyhow::{Context, Result};
use std::env;
use std::time::Duration;

/// Konfiguracja serwera czytana z env vars (patrz `.env.example`).
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub jwt_secret: String,
    pub jwt_ttl: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let database_url = env::var("DATABASE_URL").context("DATABASE_URL nie jest ustawione")?;
        let jwt_secret = env::var("JWT_SECRET").context("JWT_SECRET nie jest ustawione")?;
        if jwt_secret.len() < 32 {
            anyhow::bail!(
                "JWT_SECRET musi mieć co najmniej 32 znaki (Twój ma {})",
                jwt_secret.len()
            );
        }
        let jwt_ttl_secs: u64 = env::var("JWT_TTL_SECONDS")
            .unwrap_or_else(|_| "2592000".to_string())
            .parse()
            .context("JWT_TTL_SECONDS musi być liczbą całkowitą w sekundach")?;
        Ok(Self {
            bind_addr,
            database_url,
            jwt_secret,
            jwt_ttl: Duration::from_secs(jwt_ttl_secs),
        })
    }
}

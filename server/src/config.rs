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
    pub apns: Option<ApnsConfig>,
}

/// Konfiguracja APNs (Apple Push Notification service). Opcjonalna — gdy
/// nie ustawione, push notifications są wyłączone (logowane jako warning,
/// rest serwera działa normalnie). Wszystkie 4 zmienne muszą być razem.
#[derive(Debug, Clone)]
pub struct ApnsConfig {
    /// Ścieżka do pliku .p8 (AuthKey_XXXXXXXXXX.p8 z developer.apple.com).
    pub key_path: String,
    /// 10-znakowy Key ID z Apple Developer (Certificates → Keys).
    pub key_id: String,
    /// 10-znakowy Team ID (górny prawy róg konta developer).
    pub team_id: String,
    /// Bundle ID apki, np. com.mrellwart.gaidugaidu. Idzie do `apns-topic` header.
    pub bundle_id: String,
    /// "development" (Xcode debug build) albo "production" (TestFlight + App Store).
    /// Każdy build apki ma osobne entitlement aps-environment określające do
    /// którego sandboxa APNs jego token jest ważny.
    pub environment: ApnsEnv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApnsEnv {
    Development,
    Production,
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

        let apns = parse_apns_from_env()?;

        Ok(Self {
            bind_addr,
            database_url,
            jwt_secret,
            jwt_ttl: Duration::from_secs(jwt_ttl_secs),
            apns,
        })
    }
}

fn parse_apns_from_env() -> Result<Option<ApnsConfig>> {
    let key_path = env::var("APNS_KEY_PATH").ok();
    let key_id = env::var("APNS_KEY_ID").ok();
    let team_id = env::var("APNS_TEAM_ID").ok();
    let bundle_id = env::var("APNS_BUNDLE_ID").ok();
    // Wszystko-albo-nic. Jak choć jedna brakuje a inna jest, krzyczymy żeby
    // user nie myślał że APNs działa.
    match (key_path, key_id, team_id, bundle_id) {
        (Some(kp), Some(ki), Some(ti), Some(bi)) => {
            let environment = match env::var("APNS_ENVIRONMENT")
                .unwrap_or_else(|_| "production".to_string())
                .as_str()
            {
                "development" | "dev" | "sandbox" => ApnsEnv::Development,
                "production" | "prod" => ApnsEnv::Production,
                other => anyhow::bail!(
                    "APNS_ENVIRONMENT musi być 'development' albo 'production', dostałem '{}'",
                    other
                ),
            };
            Ok(Some(ApnsConfig {
                key_path: kp,
                key_id: ki,
                team_id: ti,
                bundle_id: bi,
                environment,
            }))
        }
        (None, None, None, None) => Ok(None),
        _ => anyhow::bail!(
            "APNs config niekompletny. Wszystkie 4 zmienne muszą być: APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (plus opcjonalne APNS_ENVIRONMENT)"
        ),
    }
}

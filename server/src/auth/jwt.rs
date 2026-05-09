use crate::error::{AppError, AppResult};
use crate::state::JwtKeys;
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// Subject = account.id (UUID jako string).
    pub sub: String,
    /// Username w momencie wystawienia tokena (cache, do logowania).
    pub username: String,
    /// Issued at (unix seconds).
    pub iat: i64,
    /// Expiration (unix seconds).
    pub exp: i64,
}

pub fn issue(keys: &JwtKeys, account_id: Uuid, username: &str, ttl: Duration) -> AppResult<String> {
    let now = Utc::now().timestamp();
    let claims = Claims {
        sub: account_id.to_string(),
        username: username.to_string(),
        iat: now,
        exp: now + ttl.as_secs() as i64,
    };
    let token = encode(&Header::default(), &claims, &keys.encoding)?;
    Ok(token)
}

pub fn verify(keys: &JwtKeys, token: &str) -> AppResult<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 30;
    let data = decode::<Claims>(token, &keys.decoding, &validation)?;
    Ok(data.claims)
}

/// Wyciąga user_id z `Claims`.
impl Claims {
    pub fn account_id(&self) -> AppResult<Uuid> {
        Uuid::parse_str(&self.sub).map_err(|_| AppError::Unauthorized)
    }
}

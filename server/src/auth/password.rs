use crate::error::{AppError, AppResult};
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};

/// Hashuje hasło Argon2id z parametrami domyślnymi (rozsądnymi w 2026).
pub fn hash_password(plain: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| AppError::PasswordHash(e.to_string()))?;
    Ok(hash.to_string())
}

/// Weryfikuje hasło względem zapisanego hasha. Zwraca `Ok(true)` jeśli pasuje.
/// Nie ujawnia, czy hash był malformed (timing-safe i side-channel-safe na
/// poziomie rozróżnienia, czy user istnieje vs hasło niepoprawne).
pub fn verify_password(plain: &str, stored_hash: &str) -> AppResult<bool> {
    let parsed = PasswordHash::new(stored_hash)
        .map_err(|e| AppError::PasswordHash(format!("malformed hash: {e}")))?;
    Ok(Argon2::default()
        .verify_password(plain.as_bytes(), &parsed)
        .is_ok())
}

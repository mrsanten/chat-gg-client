//! Tauri-side push notifications glue.
//!
//! iOS-side ObjC++ (main.mm) zapisuje device token do
//! `<NSCachesDirectory>/apns_token.txt`. Tutaj wystawiamy command który JS
//! może invoke-ować na boot apki — jak plik istnieje, zwraca hex token,
//! jak nie ma, zwraca None. JS potem POST-uje na `/me/devices`.

use std::path::PathBuf;

/// Odczytuje device token zapisany przez native ObjC code w
/// `<Library/Caches>/apns_token.txt`. None gdy plik nie istnieje (user nie
/// zgodził się na powiadomienia, albo nie jesteśmy na iOS).
#[tauri::command]
pub fn get_apns_token() -> Option<String> {
    let path = caches_token_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn caches_token_path() -> Option<PathBuf> {
    // Na iOS HOME wskazuje na app sandbox; NSCachesDirectory = $HOME/Library/Caches.
    // Na macOS $HOME/Library/Caches. Na Linux/Windows nie używamy — zwracamy None.
    #[cfg(target_os = "ios")]
    {
        let home = std::env::var_os("HOME")?;
        let mut path = PathBuf::from(home);
        path.push("Library");
        path.push("Caches");
        path.push("apns_token.txt");
        Some(path)
    }
    #[cfg(not(target_os = "ios"))]
    {
        None
    }
}

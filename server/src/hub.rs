//! In-memory hub: trzyma sockety per-account i robi fan-out komunikatów.
//!
//! Per-process pamięć — w phase 6, gdy postawimy 2+ instancje serwera,
//! podłączymy Redis pub/sub. Na MVP jeden proces wystarczy.

use crate::ws::ServerEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

/// Status presence usera. Online = aktywny, Afk = nieaktywny od dłuższego
/// czasu (klient sam sobie ustawia po N min idle). Offline NIE jest tutaj
/// trzymane bo wynika z braku połączenia w hubie.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Online,
    Afk,
}

/// Aktualna lista uchwytów do każdego usera. Vec, bo ten sam user może być
/// zalogowany na N urządzeniach (phase 4: multi-device). W phase 2 z reguły
/// jeden, ale projektujemy z myślą o przyszłości.
type Targets = HashMap<Uuid, Vec<Connection>>;

#[derive(Clone)]
pub struct Connection {
    /// Unikalne ID połączenia (per WebSocket session). Pozwala usuwać
    /// dokładnie ten socket przy disconnect.
    pub conn_id: Uuid,
    pub username: String,
    pub tx: mpsc::Sender<ServerEvent>,
}

#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<RwLock<HubState>>,
}

#[derive(Default)]
struct HubState {
    targets: Targets,
    /// Status presence per account. Brak wpisu = Online (default). Aktualizujemy
    /// gdy klient wyśle SetStatus, czyścimy gdy user zejdzie offline (żeby na
    /// kolejny login startować od Online).
    statuses: HashMap<Uuid, Status>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rejestruje nowe połączenie pod danym account_id.
    /// Zwraca `bool` mówiący "to było pierwsze połączenie" (tj. user
    /// przeszedł z offline → online, więc trzeba broadcastować presence).
    pub async fn register(&self, account_id: Uuid, conn: Connection) -> bool {
        let mut s = self.inner.write().await;
        let entry = s.targets.entry(account_id).or_default();
        let was_empty = entry.is_empty();
        entry.push(conn);
        was_empty
    }

    /// Usuwa konkretne połączenie. Zwraca `bool` mówiący "to było ostatnie
    /// połączenie tego usera" (online → offline).
    pub async fn unregister(&self, account_id: Uuid, conn_id: Uuid) -> bool {
        let mut s = self.inner.write().await;
        let Some(entry) = s.targets.get_mut(&account_id) else {
            return false;
        };
        entry.retain(|c| c.conn_id != conn_id);
        if entry.is_empty() {
            s.targets.remove(&account_id);
            // Reset statusu — kolejny login startuje od Online.
            s.statuses.remove(&account_id);
            true
        } else {
            false
        }
    }

    /// Czy user ma jakąkolwiek aktywną sesję.
    pub async fn is_online(&self, account_id: Uuid) -> bool {
        self.inner.read().await.targets.contains_key(&account_id)
    }

    /// Aktualny status presence usera (Online jeśli online, Afk jeśli online
    /// + ustawił AFK, None jeśli offline).
    pub async fn get_status(&self, account_id: Uuid) -> Option<Status> {
        let s = self.inner.read().await;
        if !s.targets.contains_key(&account_id) {
            return None;
        }
        Some(s.statuses.get(&account_id).copied().unwrap_or_default())
    }

    /// Ustawia status. Zwraca `Some(new_status)` jeśli się zmienił (warto
    /// broadcastować), `None` jeśli bez zmian albo user offline.
    pub async fn set_status(&self, account_id: Uuid, status: Status) -> Option<Status> {
        let mut s = self.inner.write().await;
        if !s.targets.contains_key(&account_id) {
            return None;
        }
        let prev = s.statuses.get(&account_id).copied().unwrap_or_default();
        if prev == status {
            return None;
        }
        s.statuses.insert(account_id, status);
        Some(status)
    }

    /// Wysyła event do każdego device tego usera. Nie czeka — drop'uje
    /// jeśli kanał pełny (slow consumer = mało nas obchodzi w MVP).
    pub async fn send_to(&self, account_id: Uuid, event: ServerEvent) {
        let s = self.inner.read().await;
        if let Some(conns) = s.targets.get(&account_id) {
            for c in conns {
                let _ = c.tx.try_send(event.clone());
            }
        }
    }
}

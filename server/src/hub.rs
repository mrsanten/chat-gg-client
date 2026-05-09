//! In-memory hub: trzyma sockety per-account i robi fan-out komunikatów.
//!
//! Per-process pamięć — w phase 6, gdy postawimy 2+ instancje serwera,
//! podłączymy Redis pub/sub. Na MVP jeden proces wystarczy.

use crate::ws::ServerEvent;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

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
    inner: Arc<RwLock<Targets>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rejestruje nowe połączenie pod danym account_id.
    /// Zwraca `bool` mówiący "to było pierwsze połączenie" (tj. user
    /// przeszedł z offline → online, więc trzeba broadcastować presence).
    pub async fn register(&self, account_id: Uuid, conn: Connection) -> bool {
        let mut map = self.inner.write().await;
        let entry = map.entry(account_id).or_default();
        let was_empty = entry.is_empty();
        entry.push(conn);
        was_empty
    }

    /// Usuwa konkretne połączenie. Zwraca `bool` mówiący "to było ostatnie
    /// połączenie tego usera" (online → offline).
    pub async fn unregister(&self, account_id: Uuid, conn_id: Uuid) -> bool {
        let mut map = self.inner.write().await;
        let Some(entry) = map.get_mut(&account_id) else {
            return false;
        };
        entry.retain(|c| c.conn_id != conn_id);
        if entry.is_empty() {
            map.remove(&account_id);
            true
        } else {
            false
        }
    }

    /// Czy user ma jakąkolwiek aktywną sesję.
    pub async fn is_online(&self, account_id: Uuid) -> bool {
        self.inner.read().await.contains_key(&account_id)
    }

    /// Wysyła event do każdego device tego usera. Nie czeka — drop'uje
    /// jeśli kanał pełny (slow consumer = mało nas obchodzi w MVP).
    pub async fn send_to(&self, account_id: Uuid, event: ServerEvent) {
        let map = self.inner.read().await;
        if let Some(conns) = map.get(&account_id) {
            for c in conns {
                let _ = c.tx.try_send(event.clone());
            }
        }
    }
}

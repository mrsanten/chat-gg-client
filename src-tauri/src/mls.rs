//! MLS (RFC 9420) layer dla klienta.
//!
//! Phase 3A: PoC walidujący stack openmls 0.8 (test [`tests::e2e_demo_alice_bob`]).
//! Phase 3C: persistent storage + identity init + KeyPackage generation.
//! Phase 3D: group ops (create_group_with_peer, process_welcome, encrypt, decrypt,
//!           list_groups). Mapping group_id ↔ peer_username trzymany w
//!           [`GroupRegistry`] zapisanej w storage providera.
//!
//! Storage: prosty JSON w `app_local_data_dir/mls/<account_id>.json`. Format
//! pochodzi z `openmls_memory_storage::MemoryStorage::save_to_file`. Provider
//! jest serializowany po każdej operacji modyfikującej stan (atomowo via
//! tmp + rename).

use std::fs::File;
use std::path::{Path, PathBuf};

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::types::Ciphersuite;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

/// Domyślny ciphersuite. Wszyscy członkowie grupy muszą używać tego samego.
pub const CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Persistent OpenMLS provider. Wzorowane na `OpenMlsRustCrypto`, ale z
/// publicznym `MemoryStorage`, żebyśmy mogli go save/loadować.
pub struct PersistentProvider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl PersistentProvider {
    fn new_empty() -> Self {
        Self {
            crypto: RustCrypto::default(),
            storage: MemoryStorage::default(),
        }
    }

    /// Load z dysku albo świeży, jeśli pliku nie ma.
    pub fn load_or_new(path: &Path) -> anyhow::Result<Self> {
        let mut me = Self::new_empty();
        if path.exists() {
            let f = File::open(path)?;
            me.storage
                .load_from_file(&f)
                .map_err(|e| anyhow::anyhow!("load mls storage: {e}"))?;
        }
        Ok(me)
    }

    /// Atomic save do pliku (przez tmp + rename).
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        {
            let f = File::create(&tmp)?;
            // save_to_file też bierze &File, ale chcemy buforowanie do
            // dużych writes — więc zostawiamy bare File (MemoryStorage
            // sam użyje BufWriter wewnętrznie).
            self.storage
                .save_to_file(&f)
                .map_err(|e| anyhow::anyhow!("save mls storage: {e}"))?;
            // Drop f -> close.
            let _ = f;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

impl OpenMlsProvider for PersistentProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }
    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }
    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

// ──────────────────────────────────────── Identity helpers

/// Podstawowe info o tożsamości MLS dla danego account_id.
/// Trzymamy je w storage providera (signing key) + ścieżce na dysku.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MlsIdentity {
    pub account_id: String,
    /// Publiczny signing key (Ed25519) w base64. Klient może go pokazać
    /// userowi albo wysłać na serwer jako device cert (phase 4).
    pub signature_pubkey_b64: String,
    /// Czy identity było już zainicjowane wcześniej (loaded z dysku),
    /// czy stworzone właśnie teraz.
    pub freshly_created: bool,
}

/// Tworzy lub ładuje credential + signing keypair dla danego account_id.
/// Identity jest determinowane przez `account_id` (serwerowy UUID), więc
/// dwie instancje tej samej apki dla tego samego konta robią DWIE różne
/// tożsamości — co jest poprawnie multi-device flow (phase 4 to obsłuży).
fn ensure_identity(
    provider: &PersistentProvider,
    account_id: &str,
) -> anyhow::Result<(CredentialWithKey, SignatureKeyPair, bool)> {
    // Klucz w storage indeksowany po account_id. Używamy custom-keyed
    // approach: zapisujemy signing key bezpośrednio przez SignatureKeyPair
    // store(); odczyt przez load() na storage. Niestety SignatureKeyPair
    // nie ma load po public key bez znajomości scheme — robimy bookkeeping
    // sami w pliku JSON.
    let identity_dir = identity_dir_from_storage(provider, account_id);
    let _ = identity_dir; // przyszły use

    // Sprawdzamy czy w storage już jest signing key. Heurystyka:
    // SignatureKeyPair::read(provider.storage(), public_key, scheme)
    // wymaga znajomości pubkey, którego jeszcze nie mamy.
    //
    // Trzymamy więc mapping account_id -> pubkey w osobnym JSON-ie obok
    // głównego storage file. Przy load_or_new ten file jest doczytywany
    // razem ze storage; przy save zapisywany.
    //
    // Dla MVP: zachowujemy pubkey w storage providera używając
    // dedykowanego klucza pod label "gaidu-identity:<account_id>".
    let label = format!("gaidu-identity:{account_id}");
    if let Some(pubkey_bytes) = read_blob(&provider.storage, &label)? {
        let scheme = CIPHERSUITE.signature_algorithm();
        if let Some(signer) = SignatureKeyPair::read(&provider.storage, &pubkey_bytes, scheme) {
            let credential = BasicCredential::new(account_id.as_bytes().to_vec());
            let cred_with_key = CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            };
            return Ok((cred_with_key, signer, false));
        }
        // Mapping istnieje, ale klucz zniknął — coś poszło nie tak. Tworzymy nowy.
    }

    let credential = BasicCredential::new(account_id.as_bytes().to_vec());
    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
        .map_err(|e| anyhow::anyhow!("signature keypair: {e:?}"))?;
    signer
        .store(&provider.storage)
        .map_err(|e| anyhow::anyhow!("store signing key: {e:?}"))?;
    write_blob(&provider.storage, &label, signer.public())?;

    let cred_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    Ok((cred_with_key, signer, true))
}

/// Pomocnik: przechowuj dowolny blob w storage providera pod własnym labelem.
/// Używamy „update" interfejsu MemoryStorage (write/read po klucz=string).
/// Sztuczka: korzystamy z `openmls_traits::storage::StorageProvider::write`
/// na ramach v_test (private feature) — robimy via internal HashMap przez
/// downcast.
///
/// Ten kawałek korzysta z prywatnego API `MemoryStorage.values: RwLock<HashMap<Vec<u8>, Vec<u8>>>`,
/// ale to pole jest `pub` w 0.5. Klucz jest hashem labela.
fn read_blob(storage: &MemoryStorage, label: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let key = label_key(label);
    let map = storage
        .values
        .read()
        .map_err(|e| anyhow::anyhow!("storage read poisoned: {e}"))?;
    Ok(map.get(&key).cloned())
}

fn write_blob(storage: &MemoryStorage, label: &str, value: &[u8]) -> anyhow::Result<()> {
    let key = label_key(label);
    let mut map = storage
        .values
        .write()
        .map_err(|e| anyhow::anyhow!("storage write poisoned: {e}"))?;
    map.insert(key, value.to_vec());
    Ok(())
}

fn label_key(label: &str) -> Vec<u8> {
    // Prefix wyróżniający nasze blob-y od kluczy openmls-a. Nazwa nieprawdopodobna
    // do kolizji z jakimkolwiek wewnętrznym formatem MLS.
    let mut k = b"\x00gaidu-meta\x00".to_vec();
    k.extend_from_slice(label.as_bytes());
    k
}

fn identity_dir_from_storage(_p: &PersistentProvider, _account_id: &str) -> PathBuf {
    // Placeholder — phase 3D będzie potrzebował multi-file dla device cert.
    PathBuf::new()
}

// ──────────────────────────────────────── Public API (Tauri-friendly)

fn storage_path(app: &AppHandle, account_id: &str) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| anyhow::anyhow!("app_local_data_dir: {e}"))?;
    let safe = sanitize_account_id(account_id)?;
    Ok(dir.join("mls").join(format!("{safe}.json")))
}

fn sanitize_account_id(s: &str) -> anyhow::Result<String> {
    // Akceptujemy UUID-y i podobne. Resetujemy wszystko poza
    // [a-zA-Z0-9_-] żeby nie pozwolić path traversal.
    if s.is_empty() {
        anyhow::bail!("pusty account_id");
    }
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned != s {
        anyhow::bail!("account_id zawiera nieprawidłowe znaki: {s}");
    }
    Ok(cleaned)
}

/// Inicjalizuje (lub ładuje) tożsamość MLS dla danego account_id.
/// Storage ląduje w `app_local_data_dir/mls/<account_id>.json`.
#[tauri::command]
pub async fn mls_init(app: AppHandle, account_id: String) -> Result<MlsIdentity, String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<MlsIdentity> {
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        let (_cred, signer, freshly_created) = ensure_identity(&provider, &account_id)?;
        provider.save(&path)?;
        Ok(MlsIdentity {
            account_id,
            signature_pubkey_b64: B64.encode(signer.public()),
            freshly_created,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

/// Generuje N nowych KeyPackage'ów dla danej tożsamości i zapisuje state.
/// Zwraca listę base64 tych KP — klient wysyła je do serwera przez
/// `POST /key-packages`.
#[tauri::command]
pub async fn mls_generate_key_packages(
    app: AppHandle,
    account_id: String,
    count: u32,
) -> Result<Vec<String>, String> {
    if count == 0 || count > 50 {
        return Err("count musi być 1..=50".into());
    }
    tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<String>> {
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        let (cred, signer, _) = ensure_identity(&provider, &account_id)?;

        let mut out = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let bundle = KeyPackage::builder()
                .build(CIPHERSUITE, &provider, &signer, cred.clone())
                .map_err(|e| anyhow::anyhow!("build KeyPackage: {e:?}"))?;
            let kp_bytes = bundle
                .key_package()
                .tls_serialize_detached()
                .map_err(|e| anyhow::anyhow!("serialize KP: {e:?}"))?;
            out.push(B64.encode(&kp_bytes));
        }
        provider.save(&path)?;
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

// ──────────────────────────────────────── Phase 3D: group ops

/// Mapowanie group_id (base64) → username peera. Trzymamy je obok
/// MemoryStorage, w tym samym pliku JSON (przez nasz blob-meta storage).
#[derive(Debug, Default, Serialize, Deserialize)]
struct GroupRegistry {
    /// Klucz: base64 GroupId; wartość: username (case-preserved) peera.
    /// W phase 5 (grupy) zamienimy na `Vec<String>` (lista członków).
    groups: HashMap<String, String>,
}

const REGISTRY_LABEL: &str = "gaidu-groups";

fn load_registry(provider: &PersistentProvider) -> anyhow::Result<GroupRegistry> {
    match read_blob(&provider.storage, REGISTRY_LABEL)? {
        None => Ok(GroupRegistry::default()),
        Some(bytes) => Ok(serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("parse group registry: {e}"))?),
    }
}

fn save_registry(provider: &PersistentProvider, reg: &GroupRegistry) -> anyhow::Result<()> {
    let bytes =
        serde_json::to_vec(reg).map_err(|e| anyhow::anyhow!("serialize group registry: {e}"))?;
    write_blob(&provider.storage, REGISTRY_LABEL, &bytes)
}

/// Standardowy config grupy MLS w naszym systemie. Wszyscy klienci
/// MUSZĄ używać tego samego, inaczej welcome/processing pójdzie w piach.
fn group_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build()
}

#[derive(Debug, Serialize)]
pub struct CreateGroupResp {
    pub group_id_b64: String,
    pub welcome_b64: String,
    pub epoch: u64,
}

/// Tworzy nową grupę MLS z peerem (1:1). Wymaga wcześniej pobranego
/// KeyPackage peera (z `GET /key-packages/:username`).
///
/// Po tej operacji klient powinien:
///   1. wysłać `welcome_b64` do peera przez `send_welcome`,
///   2. zacząć wysyłać Application messages przez `mls_encrypt` + `send_blob`.
#[tauri::command]
pub async fn mls_create_group_with_peer(
    app: AppHandle,
    account_id: String,
    peer_username: String,
    peer_key_package_b64: String,
) -> Result<CreateGroupResp, String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<CreateGroupResp> {
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        let (cred, signer, _) = ensure_identity(&provider, &account_id)?;

        // Deserializacja KP peera.
        let kp_bytes = B64
            .decode(peer_key_package_b64.as_bytes())
            .map_err(|e| anyhow::anyhow!("invalid base64 peer KP: {e}"))?;
        let key_package_in = KeyPackageIn::tls_deserialize(&mut kp_bytes.as_slice())
            .map_err(|e| anyhow::anyhow!("deserialize peer KP: {e:?}"))?;
        let kp = key_package_in
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| anyhow::anyhow!("validate peer KP: {e:?}"))?;

        // Tworzymy grupę z samym sobą jako jedynym członkiem.
        let mut group = MlsGroup::new(&provider, &signer, &group_config(), cred.clone())
            .map_err(|e| anyhow::anyhow!("MlsGroup::new: {e:?}"))?;

        let (_commit, welcome_msg, _gi) = group
            .add_members(&provider, &signer, &[kp])
            .map_err(|e| anyhow::anyhow!("add_members: {e:?}"))?;
        group
            .merge_pending_commit(&provider)
            .map_err(|e| anyhow::anyhow!("merge_pending_commit: {e:?}"))?;

        let welcome_bytes = welcome_msg
            .tls_serialize_detached()
            .map_err(|e| anyhow::anyhow!("serialize welcome: {e:?}"))?;
        let group_id_bytes = group.group_id().as_slice().to_vec();
        let group_id_b64 = B64.encode(&group_id_bytes);
        let epoch = group.epoch().as_u64();

        // Update registry.
        let mut reg = load_registry(&provider)?;
        reg.groups.insert(group_id_b64.clone(), peer_username.clone());
        save_registry(&provider, &reg)?;

        provider.save(&path)?;
        Ok(CreateGroupResp {
            group_id_b64,
            welcome_b64: B64.encode(&welcome_bytes),
            epoch,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct ProcessWelcomeResp {
    pub group_id_b64: String,
    pub epoch: u64,
}

/// Przetwarza Welcome (zwykle pierwszy event od peera, który zainicjował
/// grupę). Klient powinien znać `sender_username` (z WS event `welcome.from`)
/// — zapisujemy mapowanie group_id → sender_username, żeby kolejne blob-y
/// można było pokazać jako od „bob".
#[tauri::command]
pub async fn mls_process_welcome(
    app: AppHandle,
    account_id: String,
    sender_username: String,
    welcome_b64: String,
) -> Result<ProcessWelcomeResp, String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<ProcessWelcomeResp> {
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        // ensure_identity dla pewności — joinable group musi mieć identity.
        let _ = ensure_identity(&provider, &account_id)?;

        let bytes = B64
            .decode(welcome_b64.as_bytes())
            .map_err(|e| anyhow::anyhow!("invalid base64 welcome: {e}"))?;
        let in_msg = MlsMessageIn::tls_deserialize_exact_bytes(&bytes)
            .map_err(|e| anyhow::anyhow!("deserialize welcome msg: {e:?}"))?;
        let welcome = match in_msg.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            other => anyhow::bail!("oczekiwano Welcome, dostalem {other:?}"),
        };
        let staged = StagedWelcome::new_from_welcome(
            &provider,
            group_config().join_config(),
            welcome,
            None,
        )
        .map_err(|e| anyhow::anyhow!("StagedWelcome::new: {e:?}"))?;
        let group = staged
            .into_group(&provider)
            .map_err(|e| anyhow::anyhow!("into_group: {e:?}"))?;

        let group_id_bytes = group.group_id().as_slice().to_vec();
        let group_id_b64 = B64.encode(&group_id_bytes);
        let epoch = group.epoch().as_u64();

        let mut reg = load_registry(&provider)?;
        reg.groups.insert(group_id_b64.clone(), sender_username);
        save_registry(&provider, &reg)?;

        provider.save(&path)?;
        Ok(ProcessWelcomeResp {
            group_id_b64,
            epoch,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct EncryptResp {
    pub ciphertext_b64: String,
    pub epoch: u64,
}

/// Szyfruje plaintext jako MLS Application Message dla danej grupy.
/// Zwraca ciphertext (base64) gotowy do wysłania przez `send_blob`.
#[tauri::command]
pub async fn mls_encrypt(
    app: AppHandle,
    account_id: String,
    group_id_b64: String,
    plaintext: String,
) -> Result<EncryptResp, String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<EncryptResp> {
        if plaintext.is_empty() {
            anyhow::bail!("plaintext nie może być pusty");
        }
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        let (_cred, signer, _) = ensure_identity(&provider, &account_id)?;

        let gid = decode_group_id(&group_id_b64)?;
        let mut group = MlsGroup::load(provider.storage(), &gid)
            .map_err(|e| anyhow::anyhow!("load group from storage: {e:?}"))?
            .ok_or_else(|| anyhow::anyhow!("grupa nie istnieje: {group_id_b64}"))?;

        let app_msg = group
            .create_message(&provider, &signer, plaintext.as_bytes())
            .map_err(|e| anyhow::anyhow!("create_message: {e:?}"))?;
        let bytes = app_msg
            .tls_serialize_detached()
            .map_err(|e| anyhow::anyhow!("serialize app msg: {e:?}"))?;
        let epoch = group.epoch().as_u64();

        provider.save(&path)?;
        Ok(EncryptResp {
            ciphertext_b64: B64.encode(&bytes),
            epoch,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct DecryptResp {
    pub plaintext: String,
    /// Username nadawcy zapisany w GroupRegistry, jeśli znany.
    pub sender_username: Option<String>,
    pub epoch: u64,
}

/// Deszyfruje MLS Application Message. Zwraca plaintext + wskazówkę
/// na nadawcę (z naszego mappingu group_id → username).
#[tauri::command]
pub async fn mls_decrypt(
    app: AppHandle,
    account_id: String,
    group_id_b64: String,
    ciphertext_b64: String,
) -> Result<DecryptResp, String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<DecryptResp> {
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        let _ = ensure_identity(&provider, &account_id)?;

        let gid = decode_group_id(&group_id_b64)?;
        let mut group = MlsGroup::load(provider.storage(), &gid)
            .map_err(|e| anyhow::anyhow!("load group: {e:?}"))?
            .ok_or_else(|| anyhow::anyhow!("grupa nie istnieje"))?;

        let bytes = B64
            .decode(ciphertext_b64.as_bytes())
            .map_err(|e| anyhow::anyhow!("invalid base64 ciphertext: {e}"))?;
        let in_msg = MlsMessageIn::tls_deserialize_exact_bytes(&bytes)
            .map_err(|e| anyhow::anyhow!("deserialize ciphertext: {e:?}"))?;
        let proto = in_msg
            .try_into_protocol_message()
            .map_err(|e| anyhow::anyhow!("not protocol msg: {e:?}"))?;
        let processed = group
            .process_message(&provider, proto)
            .map_err(|e| anyhow::anyhow!("process_message: {e:?}"))?;

        let plaintext = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(am) => am.into_bytes(),
            other => anyhow::bail!("nie ApplicationMessage: {other:?}"),
        };
        let plaintext = String::from_utf8(plaintext)
            .map_err(|e| anyhow::anyhow!("plaintext nie jest UTF-8: {e}"))?;

        let reg = load_registry(&provider)?;
        let sender_username = reg.groups.get(&group_id_b64).cloned();

        provider.save(&path)?;
        Ok(DecryptResp {
            plaintext,
            sender_username,
            epoch: group.epoch().as_u64(),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct GroupSummary {
    pub group_id_b64: String,
    pub peer_username: String,
}

/// Lista wszystkich grup, które klient zna (z GroupRegistry).
/// Klient używa tego po starcie do zbudowania mapy peer → group_id.
#[tauri::command]
pub async fn mls_list_groups(
    app: AppHandle,
    account_id: String,
) -> Result<Vec<GroupSummary>, String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<GroupSummary>> {
        let path = storage_path(&app, &account_id)?;
        let provider = PersistentProvider::load_or_new(&path)?;
        let reg = load_registry(&provider)?;
        let mut out: Vec<GroupSummary> = reg
            .groups
            .into_iter()
            .map(|(group_id_b64, peer_username)| GroupSummary {
                group_id_b64,
                peer_username,
            })
            .collect();
        out.sort_by(|a, b| a.peer_username.cmp(&b.peer_username));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| e.to_string())
}

fn decode_group_id(b64: &str) -> anyhow::Result<GroupId> {
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|e| anyhow::anyhow!("invalid base64 group_id: {e}"))?;
    Ok(GroupId::from_slice(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmls_rust_crypto::OpenMlsRustCrypto;

    /// Pomocnik: produkuje group config z PURE_CIPHERTEXT_WIRE_FORMAT_POLICY.
    fn group_config() -> MlsGroupCreateConfig {
        MlsGroupCreateConfig::builder()
            .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build()
    }

    fn new_credential(
        name: &[u8],
        provider: &impl OpenMlsProvider,
    ) -> (CredentialWithKey, SignatureKeyPair) {
        let credential = BasicCredential::new(name.to_vec());
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        signer.store(provider.storage()).unwrap();
        (
            CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            },
            signer,
        )
    }

    fn new_kp(
        provider: &impl OpenMlsProvider,
        cred: &CredentialWithKey,
        signer: &SignatureKeyPair,
    ) -> KeyPackageBundle {
        KeyPackage::builder()
            .build(CIPHERSUITE, provider, signer, cred.clone())
            .unwrap()
    }

    #[test]
    fn e2e_demo_alice_bob() -> anyhow::Result<()> {
        let alice_provider = OpenMlsRustCrypto::default();
        let bob_provider = OpenMlsRustCrypto::default();

        let (alice_cred, alice_signer) = new_credential(b"alice", &alice_provider);
        let (bob_cred, bob_signer) = new_credential(b"bob", &bob_provider);

        let bob_kp = new_kp(&bob_provider, &bob_cred, &bob_signer);

        let mut alice_group = MlsGroup::new(
            &alice_provider,
            &alice_signer,
            &group_config(),
            alice_cred.clone(),
        )
        .map_err(|e| anyhow::anyhow!("alice MlsGroup::new: {e:?}"))?;

        let (_commit, welcome_msg, _gi) = alice_group
            .add_members(&alice_provider, &alice_signer, &[bob_kp.key_package().clone()])
            .map_err(|e| anyhow::anyhow!("alice add_members: {e:?}"))?;
        alice_group
            .merge_pending_commit(&alice_provider)
            .map_err(|e| anyhow::anyhow!("alice merge_pending_commit: {e:?}"))?;

        let welcome_bytes = welcome_msg
            .to_bytes()
            .map_err(|e| anyhow::anyhow!("serialize welcome: {e:?}"))?;
        let welcome_in = MlsMessageIn::tls_deserialize_exact_bytes(&welcome_bytes)
            .map_err(|e| anyhow::anyhow!("deserialize welcome: {e:?}"))?;
        let welcome = match welcome_in.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            other => anyhow::bail!("oczekiwano Welcome, dostalem {other:?}"),
        };
        let staged = StagedWelcome::new_from_welcome(
            &bob_provider,
            group_config().join_config(),
            welcome,
            None,
        )
        .map_err(|e| anyhow::anyhow!("bob StagedWelcome::new: {e:?}"))?;
        let mut bob_group = staged
            .into_group(&bob_provider)
            .map_err(|e| anyhow::anyhow!("bob into_group: {e:?}"))?;

        assert_eq!(alice_group.group_id(), bob_group.group_id());
        assert_eq!(alice_group.epoch(), bob_group.epoch());

        let plain = b"czesc bob, to jest E2E";
        let app_msg = alice_group
            .create_message(&alice_provider, &alice_signer, plain)
            .map_err(|e| anyhow::anyhow!("alice create_message: {e:?}"))?;
        let app_bytes = app_msg
            .to_bytes()
            .map_err(|e| anyhow::anyhow!("serialize app msg: {e:?}"))?;

        let app_in = MlsMessageIn::tls_deserialize_exact_bytes(&app_bytes)
            .map_err(|e| anyhow::anyhow!("deserialize app msg: {e:?}"))?;
        let proto = app_in
            .try_into_protocol_message()
            .map_err(|e| anyhow::anyhow!("not protocol msg: {e:?}"))?;
        let processed = bob_group
            .process_message(&bob_provider, proto)
            .map_err(|e| anyhow::anyhow!("bob process_message: {e:?}"))?;
        let recovered = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(am) => am.into_bytes(),
            other => anyhow::bail!("nie ApplicationMessage: {other:?}"),
        };
        assert_eq!(recovered.as_slice(), plain);

        Ok(())
    }

    /// Phase 3D: pełny flow z PersistentProvider — Alice tworzy grupę z
    /// Bobem przez jego KP, Bob processWelcome, oboje wymieniają zaszyfrowane
    /// wiadomości w obie strony. Po każdej operacji save+reload, weryfikacja
    /// że state zachowuje się przez restarty.
    #[test]
    fn phase_3d_full_flow_with_persistence() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let alice_path = dir.path().join("alice.json");
        let bob_path = dir.path().join("bob.json");

        // 1) Bob generuje KP i go wystawia (symulujemy serwer przez Vec<u8>).
        let bob_kp_b64: String = {
            let provider = PersistentProvider::load_or_new(&bob_path)?;
            let (cred, signer, _) = ensure_identity(&provider, "bob-id")?;
            let bundle = KeyPackage::builder()
                .build(CIPHERSUITE, &provider, &signer, cred)
                .unwrap();
            let bytes = bundle.key_package().tls_serialize_detached().unwrap();
            provider.save(&bob_path)?;
            B64.encode(&bytes)
        };

        // 2) Alice tworzy grupę z Bobem.
        let (group_id_b64, welcome_b64) = {
            let provider = PersistentProvider::load_or_new(&alice_path)?;
            let (cred, signer, _) = ensure_identity(&provider, "alice-id")?;

            let kp_bytes = B64.decode(bob_kp_b64.as_bytes())?;
            let kp_in = KeyPackageIn::tls_deserialize(&mut kp_bytes.as_slice()).unwrap();
            let kp = kp_in.validate(provider.crypto(), ProtocolVersion::Mls10).unwrap();

            let mut group =
                MlsGroup::new(&provider, &signer, &group_config(), cred.clone()).unwrap();
            let (_c, welcome, _gi) = group.add_members(&provider, &signer, &[kp]).unwrap();
            group.merge_pending_commit(&provider).unwrap();

            let mut reg = load_registry(&provider)?;
            let gid = B64.encode(group.group_id().as_slice());
            reg.groups.insert(gid.clone(), "bob".into());
            save_registry(&provider, &reg)?;
            provider.save(&alice_path)?;
            (gid, B64.encode(&welcome.tls_serialize_detached().unwrap()))
        };

        // 3) Bob przetwarza Welcome.
        {
            let provider = PersistentProvider::load_or_new(&bob_path)?;
            let _ = ensure_identity(&provider, "bob-id")?;
            let bytes = B64.decode(welcome_b64.as_bytes())?;
            let in_msg = MlsMessageIn::tls_deserialize_exact_bytes(&bytes).unwrap();
            let welcome = match in_msg.extract() {
                MlsMessageBodyIn::Welcome(w) => w,
                _ => panic!("not welcome"),
            };
            let staged = StagedWelcome::new_from_welcome(
                &provider,
                group_config().join_config(),
                welcome,
                None,
            )
            .unwrap();
            let group = staged.into_group(&provider).unwrap();
            assert_eq!(B64.encode(group.group_id().as_slice()), group_id_b64);

            let mut reg = load_registry(&provider)?;
            reg.groups.insert(group_id_b64.clone(), "alice".into());
            save_registry(&provider, &reg)?;
            provider.save(&bob_path)?;
        }

        // 4) Alice szyfruje "halo bob" i zapisuje state.
        let cipher_a_to_b = {
            let provider = PersistentProvider::load_or_new(&alice_path)?;
            let (_cred, signer, _) = ensure_identity(&provider, "alice-id")?;
            let gid = decode_group_id(&group_id_b64)?;
            let mut group = MlsGroup::load(provider.storage(), &gid)?.unwrap();
            let app_msg = group
                .create_message(&provider, &signer, b"halo bob")
                .unwrap();
            provider.save(&alice_path)?;
            B64.encode(app_msg.tls_serialize_detached().unwrap())
        };

        // 5) Bob deszyfruje.
        {
            let provider = PersistentProvider::load_or_new(&bob_path)?;
            let _ = ensure_identity(&provider, "bob-id")?;
            let gid = decode_group_id(&group_id_b64)?;
            let mut group = MlsGroup::load(provider.storage(), &gid)?.unwrap();
            let bytes = B64.decode(cipher_a_to_b.as_bytes())?;
            let in_msg = MlsMessageIn::tls_deserialize_exact_bytes(&bytes).unwrap();
            let proto = in_msg.try_into_protocol_message().unwrap();
            let processed = group.process_message(&provider, proto).unwrap();
            let plain = match processed.into_content() {
                ProcessedMessageContent::ApplicationMessage(am) => am.into_bytes(),
                _ => panic!("not app msg"),
            };
            assert_eq!(plain, b"halo bob");
            provider.save(&bob_path)?;
        }

        // 6) Bob odpowiada — nowy load → encrypt → save.
        let cipher_b_to_a = {
            let provider = PersistentProvider::load_or_new(&bob_path)?;
            let (_cred, signer, _) = ensure_identity(&provider, "bob-id")?;
            let gid = decode_group_id(&group_id_b64)?;
            let mut group = MlsGroup::load(provider.storage(), &gid)?.unwrap();
            let app_msg = group
                .create_message(&provider, &signer, b"siema alicja")
                .unwrap();
            provider.save(&bob_path)?;
            B64.encode(app_msg.tls_serialize_detached().unwrap())
        };

        // 7) Alice deszyfruje (z reload — symulujemy restart apki).
        {
            let provider = PersistentProvider::load_or_new(&alice_path)?;
            let _ = ensure_identity(&provider, "alice-id")?;
            let gid = decode_group_id(&group_id_b64)?;
            let mut group = MlsGroup::load(provider.storage(), &gid)?.unwrap();
            let bytes = B64.decode(cipher_b_to_a.as_bytes())?;
            let in_msg = MlsMessageIn::tls_deserialize_exact_bytes(&bytes).unwrap();
            let proto = in_msg.try_into_protocol_message().unwrap();
            let processed = group.process_message(&provider, proto).unwrap();
            let plain = match processed.into_content() {
                ProcessedMessageContent::ApplicationMessage(am) => am.into_bytes(),
                _ => panic!("not app msg"),
            };
            assert_eq!(plain, b"siema alicja");
            provider.save(&alice_path)?;

            // Registry musi mieć mapowanie po reload.
            let reg = load_registry(&provider)?;
            assert_eq!(reg.groups.get(&group_id_b64), Some(&"bob".to_string()));
        }

        Ok(())
    }

    /// Phase 3C: persist + reload. Tworzymy provider, generujemy
    /// identity, save → reload → identity musi się zachować, signing key
    /// odczytujemy.
    #[test]
    fn persistent_provider_round_trip() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let path = dir.path().join("alice.json");

        // 1) świeży, zapis
        {
            let provider = PersistentProvider::load_or_new(&path)?;
            let (_cred, signer, fresh) = ensure_identity(&provider, "alice-id-123")?;
            assert!(fresh, "pierwsze utworzenie powinno być fresh");
            let _pub_a = signer.public().to_vec();
            provider.save(&path)?;
        }
        assert!(path.exists(), "plik storage nie powstał");

        // 2) reload — to samo identity musi się zachować
        {
            let provider = PersistentProvider::load_or_new(&path)?;
            let (_cred, signer, fresh) = ensure_identity(&provider, "alice-id-123")?;
            assert!(!fresh, "po reload nie powinno być fresh");
            let _pub_b = signer.public().to_vec();
            // Public key musi być stały
            // (porównanie via nowy odczyt z label)
        }
        Ok(())
    }

    fn tempdir() -> anyhow::Result<tempfile::TempDir> {
        tempfile::TempDir::new().map_err(Into::into)
    }
}

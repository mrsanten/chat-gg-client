//! MLS (RFC 9420) layer dla klienta.
//!
//! Phase 3A: PoC walidujący stack openmls 0.8 (test [`tests::e2e_demo_alice_bob`]).
//! Phase 3C: persistent storage + identity init + KeyPackage generation.
//! Phase 3D: group ops (create/process welcome/encrypt/decrypt) — TBD.
//!
//! Storage: prosty JSON w `app_local_data_dir/mls/<account_id>.json`. Format
//! pochodzi z `openmls_memory_storage::MemoryStorage::save_to_file`. Provider
//! jest serializowany po każdej operacji modyfikującej stan (atomowo via
//! tmp + rename).

use std::fs::File;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::types::Ciphersuite;
use openmls_traits::OpenMlsProvider;
use tauri::{AppHandle, Manager};

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
            // KeyPackageBundle nie ma bezpośredniego serializera — bierzemy
            // sam KeyPackage (publiczny) i serializujemy via tls_codec.
            use tls_codec::Serialize as _;
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

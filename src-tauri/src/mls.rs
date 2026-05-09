//! Phase 3 PoC: MLS (RFC 9420) end-to-end.
//!
//! Cel: udowodnić, że stack openmls 0.8 z RustCrypto providerem działa w
//! naszym setupie. Test [`tests::e2e_demo_alice_bob`] tworzy dwie tożsamości,
//! wymienia KeyPackage, łączy w grupę przez Welcome i przesyła
//! zaszyfrowaną wiadomość w obie strony.
//!
//! W tym pliku NIE eksportujemy jeszcze niczego do runtime apki — to
//! tylko walidacja, że biblioteka się kompiluje i podstawowy flow
//! przechodzi. Integracja z `chat.rs` / klient WS przyjdzie w phase 3B+.

#![allow(dead_code)]

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::types::Ciphersuite;

/// Ciphersuite, której się trzymamy — MLS spec wymaga, żeby wszyscy
/// członkowie grupy używali tej samej. Wybieramy wariant z X25519 +
/// AES-128-GCM + Ed25519 + SHA-256, default RFC 9420 dla powszechnej
/// interopu i niskim koszcie.
pub const CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Tworzy `BasicCredential` + zapisuje signing keypair w storage providera.
/// Zwracany `CredentialWithKey` jest tym, czym członek grupy jest
/// reprezentowany w `MlsGroup`.
fn new_credential(
    name: &[u8],
    provider: &impl OpenMlsProvider,
) -> anyhow::Result<(CredentialWithKey, SignatureKeyPair)> {
    let credential = BasicCredential::new(name.to_vec());
    let signature_keys = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
        .map_err(|e| anyhow::anyhow!("signature keypair: {e:?}"))?;
    signature_keys
        .store(provider.storage())
        .map_err(|e| anyhow::anyhow!("store signing key: {e:?}"))?;
    Ok((
        CredentialWithKey {
            credential: credential.into(),
            signature_key: signature_keys.public().into(),
        },
        signature_keys,
    ))
}

/// Generuje świeży KeyPackage dla danej tożsamości. KeyPackage to
/// publiczny pakiet, który użytkownik publikuje na serwerze, żeby ktoś
/// inny mógł zacząć z nim rozmowę bez czekania, aż będzie online.
fn new_key_package(
    provider: &impl OpenMlsProvider,
    credential: &CredentialWithKey,
    signer: &SignatureKeyPair,
) -> anyhow::Result<KeyPackageBundle> {
    KeyPackage::builder()
        .build(CIPHERSUITE, provider, signer, credential.clone())
        .map_err(|e| anyhow::anyhow!("build KeyPackage: {e:?}"))
}

/// Konfiguracja grupy MLS. Domyślnie `PURE_CIPHERTEXT_WIRE_FORMAT_POLICY`,
/// tj. wszystkie wiadomości — handshake i application — są zaszyfrowane
/// (metadane też). Konstruktor `WireFormatPolicy::new` jest `pub(crate)`
/// w 0.8, więc używamy publicznej stałej.
fn group_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e2e_demo_alice_bob() -> anyhow::Result<()> {
        // Każda strona ma własny `OpenMlsProvider` — symuluje dwa różne
        // urządzenia. W realnej apce każda instancja Tauri ma swój
        // (na razie in-memory; w phase 3C zastąpimy persistent storagiem).
        let alice_provider = OpenMlsRustCrypto::default();
        let bob_provider = OpenMlsRustCrypto::default();

        let (alice_cred, alice_signer) = new_credential(b"alice", &alice_provider)?;
        let (bob_cred, bob_signer) = new_credential(b"bob", &bob_provider)?;

        // Bob publikuje KeyPackage. Alice go „zabiera" (w prawdziwym
        // setupie z serwera) i tworzy z nim grupę.
        let bob_kp = new_key_package(&bob_provider, &bob_cred, &bob_signer)?;

        // Alice tworzy grupę z samą sobą jako jedynym członkiem.
        let mut alice_group = MlsGroup::new(
            &alice_provider,
            &alice_signer,
            &group_config(),
            alice_cred.clone(),
        )
        .map_err(|e| anyhow::anyhow!("alice MlsGroup::new: {e:?}"))?;

        // Alice dodaje Boba — `add_members` zwraca:
        //  - commit (do ratchet tree update Alice'i),
        //  - welcome (do wysłania Bobowi, zawiera materiał do zjoinowania),
        //  - group_info (opcjonalne metadane).
        let (commit_msg, welcome_msg, _group_info) = alice_group
            .add_members(&alice_provider, &alice_signer, &[bob_kp.key_package().clone()])
            .map_err(|e| anyhow::anyhow!("alice add_members: {e:?}"))?;

        // Alice musi merge'nąć własny commit, żeby ratchet tree się zsynchronizował.
        alice_group
            .merge_pending_commit(&alice_provider)
            .map_err(|e| anyhow::anyhow!("alice merge_pending_commit: {e:?}"))?;

        // Commit nie jest tu używany dla single-recipient grupy, ale w
        // grupie wielu członków rozesłałby się jako `Commit` event.
        let _ = commit_msg;

        // Bob odbiera Welcome. W realu serwer to przekazuje, tutaj
        // serializujemy/deserializujemy żeby nie udawać shared state.
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

        // Test brzytwy #1: oba groupy mają ten sam GroupId i epoch.
        assert_eq!(alice_group.group_id(), bob_group.group_id());
        assert_eq!(alice_group.epoch(), bob_group.epoch());

        // Alice szyfruje wiadomość → ciphertext idzie do Boba.
        let plain = b"czesc bob, to jest E2E";
        let app_msg = alice_group
            .create_message(&alice_provider, &alice_signer, plain)
            .map_err(|e| anyhow::anyhow!("alice create_message: {e:?}"))?;
        let app_bytes = app_msg
            .to_bytes()
            .map_err(|e| anyhow::anyhow!("serialize app msg: {e:?}"))?;

        // Bob deszyfruje.
        let app_in = MlsMessageIn::tls_deserialize_exact_bytes(&app_bytes)
            .map_err(|e| anyhow::anyhow!("deserialize app msg: {e:?}"))?;
        let protocol_msg = app_in
            .try_into_protocol_message()
            .map_err(|e| anyhow::anyhow!("not protocol msg: {e:?}"))?;
        let processed = bob_group
            .process_message(&bob_provider, protocol_msg)
            .map_err(|e| anyhow::anyhow!("bob process_message: {e:?}"))?;
        let recovered = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(am) => am.into_bytes(),
            other => anyhow::bail!("nie ApplicationMessage: {other:?}"),
        };
        assert_eq!(recovered.as_slice(), plain);

        // Druga strona, druga wiadomość: Bob → Alice.
        let plain2 = b"siema alicja, dziala";
        let app2 = bob_group
            .create_message(&bob_provider, &bob_signer, plain2)
            .map_err(|e| anyhow::anyhow!("bob create_message: {e:?}"))?;
        let bytes2 = app2
            .to_bytes()
            .map_err(|e| anyhow::anyhow!("serialize bob msg: {e:?}"))?;

        let in2 = MlsMessageIn::tls_deserialize_exact_bytes(&bytes2)
            .map_err(|e| anyhow::anyhow!("deserialize bob msg: {e:?}"))?;
        let proto2 = in2
            .try_into_protocol_message()
            .map_err(|e| anyhow::anyhow!("not protocol msg: {e:?}"))?;
        let processed2 = alice_group
            .process_message(&alice_provider, proto2)
            .map_err(|e| anyhow::anyhow!("alice process_message: {e:?}"))?;
        let recovered2 = match processed2.into_content() {
            ProcessedMessageContent::ApplicationMessage(am) => am.into_bytes(),
            other => anyhow::bail!("nie ApplicationMessage: {other:?}"),
        };
        assert_eq!(recovered2.as_slice(), plain2);

        Ok(())
    }
}

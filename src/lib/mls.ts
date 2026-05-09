/**
 * Cienka warstwa nad Tauri commands do MLS.
 *
 * Storage MLS-a (klucze, group state) trzymane jest w Rust w
 * `app_local_data_dir/mls/<account_id>.json`. JS dotyka go tylko przez te
 * komendy — żadna część stanu kryptograficznego nie wycieka do JS-a, tym
 * samym nawet zhakowany WebView nie ujawni private keya.
 */

import { invoke } from "@tauri-apps/api/core";

export interface MlsIdentity {
  account_id: string;
  signature_pubkey_b64: string;
  freshly_created: boolean;
}

/**
 * Tworzy lub ładuje tożsamość MLS dla danego account_id. Idempotentne —
 * można wołać przy każdym starcie, tożsamość zostanie odnaleziona w
 * pliku jeśli już istnieje.
 */
export function mlsInit(accountId: string): Promise<MlsIdentity> {
  return invoke<MlsIdentity>("mls_init", { accountId });
}

/**
 * Generuje N nowych KeyPackage'ów do publikacji na serwerze. Każdy KP
 * jest jednorazowy — serwer odda go jednemu peerowi, który zaczyna z
 * nami nową konwersację.
 */
export function mlsGenerateKeyPackages(
  accountId: string,
  count: number,
): Promise<string[]> {
  return invoke<string[]>("mls_generate_key_packages", { accountId, count });
}

// ─────────────────────────────────── Phase 3D: group ops

export interface CreateGroupResp {
  group_id_b64: string;
  welcome_b64: string;
  epoch: number;
}

/**
 * Tworzy nową grupę MLS z peerem na bazie jego KeyPackage. Zwraca
 * `welcome_b64` do wysłania (zwykle przez `send_welcome` WS event)
 * i `group_id_b64` do trzymania w mappingu peer → group.
 */
export function mlsCreateGroupWithPeer(
  accountId: string,
  peerUsername: string,
  peerKeyPackageB64: string,
): Promise<CreateGroupResp> {
  return invoke<CreateGroupResp>("mls_create_group_with_peer", {
    accountId,
    peerUsername,
    peerKeyPackageB64,
  });
}

export interface ProcessWelcomeResp {
  group_id_b64: string;
  epoch: number;
}

/**
 * Przetwarza Welcome od peera (zwykle pierwszy event w nowej konwersacji).
 * Po sukcesie klient ma już group state i może deszyfrować przyszłe blob-y.
 */
export function mlsProcessWelcome(
  accountId: string,
  senderUsername: string,
  welcomeB64: string,
): Promise<ProcessWelcomeResp> {
  return invoke<ProcessWelcomeResp>("mls_process_welcome", {
    accountId,
    senderUsername,
    welcomeB64,
  });
}

export interface EncryptResp {
  ciphertext_b64: string;
  epoch: number;
}

export function mlsEncrypt(
  accountId: string,
  groupIdB64: string,
  plaintext: string,
): Promise<EncryptResp> {
  return invoke<EncryptResp>("mls_encrypt", {
    accountId,
    groupIdB64,
    plaintext,
  });
}

export interface DecryptResp {
  plaintext: string;
  sender_username: string | null;
  epoch: number;
}

export function mlsDecrypt(
  accountId: string,
  groupIdB64: string,
  ciphertextB64: string,
): Promise<DecryptResp> {
  return invoke<DecryptResp>("mls_decrypt", {
    accountId,
    groupIdB64,
    ciphertextB64,
  });
}

export interface GroupSummary {
  group_id_b64: string;
  peer_username: string;
}

export function mlsListGroups(accountId: string): Promise<GroupSummary[]> {
  return invoke<GroupSummary[]>("mls_list_groups", { accountId });
}

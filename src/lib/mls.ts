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

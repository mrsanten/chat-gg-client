import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types";
import { DEFAULT_SETTINGS } from "../types";

export async function loadSettings(): Promise<Settings> {
  try {
    const s = await invoke<Settings>("load_settings");
    return mergeDefaults(s);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("save_settings", { settings });
}

function mergeDefaults(s: Partial<Settings> | null | undefined): Settings {
  if (!s) return DEFAULT_SETTINGS;
  return {
    anthropic: {
      auth: s.anthropic?.auth ?? { mode: "none" },
      model_id: s.anthropic?.model_id ?? null,
    },
    openai: {
      auth: s.openai?.auth ?? { mode: "none" },
      model_id: s.openai?.model_id ?? null,
    },
    moonshot: {
      auth: s.moonshot?.auth ?? { mode: "none" },
      model_id: s.moonshot?.model_id ?? null,
    },
    macros: Array.isArray(s.macros) ? s.macros : [],
    profile: {
      nick: typeof s.profile?.nick === "string" ? s.profile.nick : "",
    },
    network: {
      // Server URL jest hardcoded — UI nie pozwala go zmienić. Każde stare
      // settings.json (np. z http://localhost:8080 z dev-a) snapuje się
      // do produkcyjnej instancji przy najbliższym wczytaniu.
      server_url: PRODUCTION_SERVER_URL,
      token: typeof s.network?.token === "string" ? s.network.token : "",
      account_id: s.network?.account_id ?? null,
      username: s.network?.username ?? null,
    },
  };
}

/**
 * Adres produkcyjnego serwera GAIdu. Trzymany centralnie, importowany przez
 * `mergeDefaults` (force-set) i przez `DEFAULT_SETTINGS` w types.ts.
 */
export const PRODUCTION_SERVER_URL = "https://gg.jacula.cloud";

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
  };
}

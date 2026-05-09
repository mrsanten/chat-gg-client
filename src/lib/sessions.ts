import { invoke } from "@tauri-apps/api/core";
import type { ChatSession, SessionMeta } from "../types";

export async function listSessions(): Promise<SessionMeta[]> {
  try {
    return await invoke<SessionMeta[]>("list_sessions");
  } catch {
    return [];
  }
}

export async function loadSession(id: string): Promise<ChatSession | null> {
  try {
    const s = await invoke<ChatSession | null>("load_session", { id });
    return s ?? null;
  } catch {
    return null;
  }
}

export async function saveSession(session: ChatSession): Promise<void> {
  await invoke("save_session", { session });
}

export async function deleteSession(id: string): Promise<void> {
  await invoke("delete_session", { id });
}

export function deriveTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 40) return cleaned || "Nowa rozmowa";
  return cleaned.slice(0, 37) + "...";
}

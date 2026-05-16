import { invoke } from "@tauri-apps/api/core";
import * as serverApi from "./serverApi";
import type { ChatSession, SessionMeta } from "../types";

/**
 * AI chat sessions — local-first + server sync.
 *
 * - LOKALNIE: Tauri commands (`list_sessions` itp.) trzymają sesje w JSON-ie
 *   w app-data-dir. Ten katalog PRZEŻYWA aktualizacje apki (stabilna ścieżka
 *   per bundle-id). To gwarantuje że historia nie znika po update.
 * - SERWER: REST `/me/sessions` synchronizuje między urządzeniami.
 *
 * Każdy zapis idzie do OBU. Odczyt mergie — wygrywa nowsza wersja (updatedAt).
 * Server-only z poprzednich wersji był błędem: hiccup serwera / brak deployu
 * = utrata historii po restarcie.
 */

/** Cache pełnych sesji w pamięci (id → ChatSession). */
const cache = new Map<string, ChatSession>();

// ─────────── lokalna warstwa (Tauri commands)

async function localList(): Promise<SessionMeta[]> {
  try {
    return await invoke<SessionMeta[]>("list_sessions");
  } catch {
    return [];
  }
}

async function localLoad(id: string): Promise<ChatSession | null> {
  try {
    return (await invoke<ChatSession | null>("load_session", { id })) ?? null;
  } catch {
    return null;
  }
}

async function localSave(session: ChatSession): Promise<void> {
  try {
    await invoke("save_session", { session });
  } catch (e) {
    console.warn("[sessions] local save failed:", e);
  }
}

async function localDelete(id: string): Promise<void> {
  try {
    await invoke("delete_session", { id });
  } catch (e) {
    console.warn("[sessions] local delete failed:", e);
  }
}

// ─────────── konwersja server row → ChatSession

function rowToSession(r: serverApi.ServerAiSession): ChatSession {
  return {
    id: r.id,
    modelId: r.model_id,
    title: r.title,
    messages: Array.isArray(r.messages)
      ? (r.messages as ChatSession["messages"])
      : [],
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

// ─────────── public API

export async function listSessions(
  serverUrl?: string,
  token?: string,
): Promise<SessionMeta[]> {
  // Lokalne — zawsze dostępne, instant, offline-safe.
  const byId = new Map<string, SessionMeta>();
  for (const m of await localList()) byId.set(m.id, m);

  // Serwer — merge, nowsza wersja (updatedAt) wygrywa.
  if (serverUrl && token) {
    try {
      const remote = await serverApi.listAiSessions(serverUrl, token);
      for (const r of remote) {
        const s = rowToSession(r);
        const meta: SessionMeta = {
          id: s.id,
          modelId: s.modelId,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
        };
        const existing = byId.get(s.id);
        if (!existing || meta.updatedAt >= existing.updatedAt) {
          byId.set(s.id, meta);
        }
        // Cache pełną sesję z serwera jeśli nowsza-lub-równa wersji w cache.
        const cached = cache.get(s.id);
        if (!cached || s.updatedAt >= cached.updatedAt) {
          cache.set(s.id, s);
        }
      }
    } catch (e) {
      console.warn("[sessions] server listSessions failed:", e);
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(
  id: string,
  serverUrl?: string,
  token?: string,
): Promise<ChatSession | null> {
  // Zbierz wszystkie warianty (cache / local), wybierz najnowszy.
  const cached = cache.get(id) ?? null;
  const local = await localLoad(id);
  let best: ChatSession | null = cached;
  if (local && (!best || local.updatedAt > best.updatedAt)) best = local;
  if (best) {
    cache.set(id, best);
    return best;
  }
  // Ani w cache ani lokalnie — dociągnij z serwera.
  if (serverUrl && token) {
    try {
      const remote = await serverApi.listAiSessions(serverUrl, token);
      for (const r of remote) cache.set(r.id, rowToSession(r));
      return cache.get(id) ?? null;
    } catch (e) {
      console.warn("[sessions] server loadSession failed:", e);
    }
  }
  return null;
}

export async function saveSession(
  session: ChatSession,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  cache.set(session.id, session);
  // Local zawsze — to jest źródło prawdy odporne na update / offline.
  await localSave(session);
  // Server best-effort — sync między urządzeniami.
  if (serverUrl && token) {
    try {
      await serverApi.upsertAiSession(serverUrl, token, {
        id: session.id,
        model_id: session.modelId,
        title: session.title,
        messages: session.messages as unknown[],
        created_at: new Date(session.createdAt).toISOString(),
        updated_at: new Date(session.updatedAt).toISOString(),
      });
    } catch (e) {
      console.warn("[sessions] server saveSession failed:", e);
    }
  }
}

export async function deleteSession(
  id: string,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  cache.delete(id);
  await localDelete(id);
  if (serverUrl && token) {
    try {
      await serverApi.deleteAiSession(serverUrl, token, id);
    } catch (e) {
      console.warn("[sessions] server deleteSession failed:", e);
    }
  }
}

/** Reset in-memory cache. Wywołać przy logout — lokalne pliki ZOSTAJĄ
 *  (to ten sam OS-user, sesje mają sens dalej), tylko cache się czyści. */
export function clearSessionCache(): void {
  cache.clear();
}

export function deriveTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 40) return cleaned || "Nowa rozmowa";
  return cleaned.slice(0, 37) + "...";
}

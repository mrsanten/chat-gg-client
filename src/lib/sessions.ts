import * as serverApi from "./serverApi";
import type { ChatSession, SessionMeta } from "../types";

/** Cache po stronie klienta — pełne sesje pobrane z server-a. Trzymane
 *  pamięciowo, nie persistowane. Klucz: session.id. */
const sessionCache = new Map<string, ChatSession>();
let allFetched = false;

async function fetchAll(
  serverUrl: string,
  token: string,
): Promise<ChatSession[]> {
  const rows = await serverApi.listAiSessions(serverUrl, token);
  sessionCache.clear();
  for (const r of rows) {
    const session: ChatSession = {
      id: r.id,
      modelId: r.model_id,
      title: r.title,
      // server zwraca tablicę nieznanych — łapiemy jako messages (klient
      // sam wie kontrakt; jeśli ktoś manipulował JSON-em, zwracamy []).
      messages: Array.isArray(r.messages)
        ? (r.messages as ChatSession["messages"])
        : [],
      createdAt: new Date(r.created_at).getTime(),
      updatedAt: new Date(r.updated_at).getTime(),
    };
    sessionCache.set(session.id, session);
  }
  allFetched = true;
  return Array.from(sessionCache.values());
}

export async function listSessions(
  serverUrl?: string,
  token?: string,
): Promise<SessionMeta[]> {
  if (!serverUrl || !token) return [];
  try {
    const sessions = await fetchAll(serverUrl, token);
    return sessions
      .map((s) => ({
        id: s.id,
        modelId: s.modelId,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    console.warn("[sessions] listSessions failed:", e);
    return [];
  }
}

export async function loadSession(
  id: string,
  serverUrl?: string,
  token?: string,
): Promise<ChatSession | null> {
  // Cache hit zwracamy. Server-side nie ma per-id endpoint-u — lista jest
  // mała (sesje całego konta), więc full fetch po starcie i potem cache.
  const cached = sessionCache.get(id);
  if (cached) return cached;
  if (!serverUrl || !token) return null;
  if (!allFetched) {
    try {
      await fetchAll(serverUrl, token);
    } catch {
      return null;
    }
  }
  return sessionCache.get(id) ?? null;
}

export async function saveSession(
  session: ChatSession,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  sessionCache.set(session.id, session);
  if (!serverUrl || !token) return;
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
    console.warn("[sessions] saveSession failed:", e);
  }
}

export async function deleteSession(
  id: string,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  sessionCache.delete(id);
  if (!serverUrl || !token) return;
  try {
    await serverApi.deleteAiSession(serverUrl, token, id);
  } catch (e) {
    console.warn("[sessions] deleteSession failed:", e);
  }
}

/** Resetuje in-memory cache. Wywołać przy logout. */
export function clearSessionCache(): void {
  sessionCache.clear();
  allFetched = false;
}

export function deriveTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 40) return cleaned || "Nowa rozmowa";
  return cleaned.slice(0, 37) + "...";
}

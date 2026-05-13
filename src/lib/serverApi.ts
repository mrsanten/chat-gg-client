/**
 * REST helpery do `gaidu-server`. Cienka warstwa nad fetch z obsługą JWT
 * w nagłówku i znormalizowanymi błędami.
 *
 * Wszystkie funkcje przyjmują `serverUrl` jako pierwszy argument, żeby user
 * mógł wskazywać dowolny serwer (lokalny dev, Twój VPS, znajomego instancja).
 */

export interface ServerAccount {
  id: string;
  username: string;
  created_at: string;
  description?: string;
  /** Avatar jako data URL ("data:image/...;base64,..."). Pusty/brak = brak. */
  avatar?: string;
}

export interface AuthResponse {
  token: string;
  account: ServerAccount;
}

export interface ServerContact {
  peer_id: string;
  username: string;
  nickname: string | null;
  created_at: string;
  online: boolean;
  /** Granularny status. Brak (stary serwer) → online jeśli `online=true`. */
  status?: "online" | "afk" | "push_reachable" | "offline";
  description?: string;
  /** Avatar peera jako data URL. Pusty/brak = brak (renderujemy default). */
  avatar?: string;
}

export interface ServerMessage {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  created_at: string;
  delivered_at: string | null;
}

export type HistoryEntry =
  | {
      kind: "plain";
      id: string;
      from_id: string;
      to_id: string;
      body: string;
      created_at: string;
      delivered_at: string | null;
    }
  | {
      kind: "blob";
      id: string;
      from_id: string;
      to_id: string;
      group_id: string;
      epoch: number;
      ciphertext: string;
      created_at: string;
      delivered_at: string | null;
    };

export class ServerError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.code = code;
  }
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Normalizuje URL serwera: dorzuca `https://` jeśli brakuje schemy,
 * usuwa trailing slash. Bez schemy fetch traktuje stringa jako relatywny
 * path do tauri://localhost/, co kończy się dziwnym 200 z pustym body
 * i mylącym JS error w UI.
 */
export function normalizeServerUrl(input: string): string {
  let url = (input ?? "").trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return trimUrl(url);
}

async function request<T>(
  method: string,
  serverUrl: string,
  path: string,
  options: { token?: string | null; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;

  const fullUrl = `${normalizeServerUrl(serverUrl)}${path}`;
  let resp: Response;
  try {
    resp = await fetch(fullUrl, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ServerError(0, "network", `Brak połączenia z serwerem: ${msg}`);
  }

  if (resp.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await resp.json();
  } catch {
    // pusty albo nie-JSON body
  }

  if (!resp.ok) {
    const code =
      (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : null) ?? `http_${resp.status}`;
    const message =
      (payload && typeof payload === "object" && "message" in payload && typeof (payload as { message: unknown }).message === "string"
        ? (payload as { message: string }).message
        : null) ?? resp.statusText ?? `HTTP ${resp.status}`;
    throw new ServerError(resp.status, code, message);
  }

  // 200 OK + brak/zły JSON to nie powinna sytuacja dla naszego API. Zamiast
  // przepuszczać `null` dalej (i crashować w callerze przy `.token`),
  // zgłaszamy czytelny błąd.
  if (payload == null && resp.status !== 204) {
    throw new ServerError(
      resp.status,
      "empty_body",
      `Serwer zwrócił pusty response (HTTP ${resp.status}). Sprawdź czy URL ma poprawną schemę (https://) i czy proxy nie buforuje błędu.`,
    );
  }

  return payload as T;
}

export async function register(
  serverUrl: string,
  username: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("POST", serverUrl, "/auth/register", {
    body: { username, password },
  });
}

export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("POST", serverUrl, "/auth/login", {
    body: { username, password },
  });
}

export async function me(serverUrl: string, token: string): Promise<ServerAccount> {
  return request<ServerAccount>("GET", serverUrl, "/me", { token });
}

/** PUT /me/profile — aktualizuje opis usera (max 200 znaków). */
export async function updateProfile(
  serverUrl: string,
  token: string,
  description: string,
): Promise<ServerAccount> {
  return request<ServerAccount>("PUT", serverUrl, "/me/profile", {
    token,
    body: { description },
  });
}

// ─────────────────────────────────── Push notifications (APNs / FCM)

export interface RegisterDeviceReq {
  token: string;
  platform: "ios" | "android";
  app_bundle_id: string;
  /** "development" (Xcode dev build) albo "production" (TestFlight/App Store). */
  apns_env: "development" | "production";
}

/** POST /me/devices — rejestruje (upsert) push token dla zalogowanego konta. */
export async function registerDevice(
  serverUrl: string,
  token: string,
  body: RegisterDeviceReq,
): Promise<void> {
  await request<void>("POST", serverUrl, "/me/devices", {
    token,
    body,
  });
}

/** DELETE /me/devices/{token} — usuwa push token (np. przy logout). */
export async function unregisterDevice(
  serverUrl: string,
  token: string,
  deviceToken: string,
): Promise<void> {
  await request<void>(
    "DELETE",
    serverUrl,
    `/me/devices/${encodeURIComponent(deviceToken)}`,
    { token },
  );
}

/** PUT /me/avatar — aktualizuje avatar usera (data URL, max ~200 KB). */
export async function updateAvatar(
  serverUrl: string,
  token: string,
  avatar: string,
): Promise<ServerAccount> {
  return request<ServerAccount>("PUT", serverUrl, "/me/avatar", {
    token,
    body: { avatar },
  });
}

export async function listContacts(
  serverUrl: string,
  token: string,
): Promise<ServerContact[]> {
  return request<ServerContact[]>("GET", serverUrl, "/contacts", { token });
}

export async function addContact(
  serverUrl: string,
  token: string,
  username: string,
  nickname?: string,
): Promise<ServerContact> {
  return request<ServerContact>("POST", serverUrl, "/contacts", {
    token,
    body: { username, nickname },
  });
}

export async function removeContact(
  serverUrl: string,
  token: string,
  peerId: string,
): Promise<void> {
  await request<void>("DELETE", serverUrl, `/contacts/${encodeURIComponent(peerId)}`, {
    token,
  });
}

// ─────────────────────────────────── Groups

export interface ServerGroup {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  my_role: "admin" | "member";
  member_count: number;
}

export interface ServerGroupMember {
  account_id: string;
  username: string;
  role: "admin" | "member";
  joined_at: string;
  avatar?: string;
}

export interface ServerGroupMessage {
  id: string;
  group_id: string;
  sender_id: string;
  sender_username: string;
  body: string;
  created_at: string;
}

/** POST /groups — tworzy grupę, autor staje się adminem. */
export async function createGroup(
  serverUrl: string,
  token: string,
  name: string,
  memberUsernames: string[],
): Promise<ServerGroup> {
  return request<ServerGroup>("POST", serverUrl, "/groups", {
    token,
    body: { name, member_usernames: memberUsernames },
  });
}

/** GET /groups — lista moich grup. */
export async function listGroups(
  serverUrl: string,
  token: string,
): Promise<ServerGroup[]> {
  return request<ServerGroup[]>("GET", serverUrl, "/groups", { token });
}

/** GET /groups/{id}/members — lista członków. */
export async function listGroupMembers(
  serverUrl: string,
  token: string,
  groupId: string,
): Promise<ServerGroupMember[]> {
  return request<ServerGroupMember[]>(
    "GET",
    serverUrl,
    `/groups/${encodeURIComponent(groupId)}/members`,
    { token },
  );
}

/** PATCH /groups/{id} — zmień nazwę grupy (admin only). */
export async function updateGroup(
  serverUrl: string,
  token: string,
  groupId: string,
  name: string,
): Promise<void> {
  await request<void>("PATCH", serverUrl, `/groups/${encodeURIComponent(groupId)}`, {
    token,
    body: { name },
  });
}

/** POST /groups/{id}/members — dodaj członka po username (admin only). */
export async function addGroupMember(
  serverUrl: string,
  token: string,
  groupId: string,
  username: string,
): Promise<void> {
  await request<void>(
    "POST",
    serverUrl,
    `/groups/${encodeURIComponent(groupId)}/members`,
    { token, body: { username } },
  );
}

/** DELETE /groups/{id}/members/{user_id} — usuń (admin) albo opuść (self). */
export async function removeGroupMember(
  serverUrl: string,
  token: string,
  groupId: string,
  userId: string,
): Promise<void> {
  await request<void>(
    "DELETE",
    serverUrl,
    `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    { token },
  );
}

/** DELETE /groups/{id} — usuń grupę (admin only, cascade). */
export async function deleteGroup(
  serverUrl: string,
  token: string,
  groupId: string,
): Promise<void> {
  await request<void>(
    "DELETE",
    serverUrl,
    `/groups/${encodeURIComponent(groupId)}`,
    { token },
  );
}

/** GET /groups/{id}/history — historia wiadomości grupy. */
export async function fetchGroupHistory(
  serverUrl: string,
  token: string,
  groupId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ServerGroupMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  const qs = params.toString() ? `?${params}` : "";
  return request<ServerGroupMessage[]>(
    "GET",
    serverUrl,
    `/groups/${encodeURIComponent(groupId)}/history${qs}`,
    { token },
  );
}

export async function fetchHistory(
  serverUrl: string,
  token: string,
  peer: string,
  opts: { limit?: number; before?: string } = {},
): Promise<HistoryEntry[]> {
  const params = new URLSearchParams({ peer });
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  return request<HistoryEntry[]>("GET", serverUrl, `/history?${params}`, { token });
}

// ─────────────────────────────────── KeyPackages (MLS, phase 3)

export interface KeyPackagesPublishResp {
  stored: number;
  total_unconsumed: number;
}

export interface KeyPackagesCountResp {
  unconsumed: number;
}

export interface KeyPackageClaim {
  id: string;
  username: string;
  data: string; // base64
}

/** Publikuje listę KeyPackage'ów (każdy w base64). Server odda je peerom. */
export async function publishKeyPackages(
  serverUrl: string,
  token: string,
  packages: string[],
): Promise<KeyPackagesPublishResp> {
  return request<KeyPackagesPublishResp>("POST", serverUrl, "/key-packages", {
    token,
    body: { packages },
  });
}

/** Ile własnych KP nie zostało jeszcze zużytych przez peerów. */
export async function keyPackagesCount(
  serverUrl: string,
  token: string,
): Promise<KeyPackagesCountResp> {
  return request<KeyPackagesCountResp>("GET", serverUrl, "/key-packages/_count", { token });
}

/** Pobiera (i konsumuje) jeden KP wskazanego peera. 404 = peer nie istnieje, 409 = pusto. */
export async function claimKeyPackage(
  serverUrl: string,
  token: string,
  username: string,
): Promise<KeyPackageClaim> {
  return request<KeyPackageClaim>(
    "GET",
    serverUrl,
    `/key-packages/${encodeURIComponent(username)}`,
    { token },
  );
}

export async function healthz(serverUrl: string): Promise<boolean> {
  try {
    await request<{ ok: boolean }>("GET", serverUrl, "/healthz");
    return true;
  } catch {
    return false;
  }
}

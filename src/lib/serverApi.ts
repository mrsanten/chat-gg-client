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
}

export interface ServerMessage {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  created_at: string;
  delivered_at: string | null;
}

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

async function request<T>(
  method: string,
  serverUrl: string,
  path: string,
  options: { token?: string | null; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;

  let resp: Response;
  try {
    resp = await fetch(`${trimUrl(serverUrl)}${path}`, {
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

export async function fetchHistory(
  serverUrl: string,
  token: string,
  peer: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ServerMessage[]> {
  const params = new URLSearchParams({ peer });
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  return request<ServerMessage[]>("GET", serverUrl, `/history?${params}`, { token });
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

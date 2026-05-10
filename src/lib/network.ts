/**
 * WebSocket klient dla `gaidu-server`. Cienka warstwa nad natywnym
 * WebSocket-em z:
 * - typowanym wire protocol (`ClientEvent` ⇄ `ServerEvent`),
 * - auto-reconnectem z backoffem,
 * - kolejką wychodzących na czas dropa połączenia,
 * - automatycznym ack-iem dostarczonych wiadomości,
 * - listenerami subskrybującymi konkretne typy zdarzeń.
 *
 * Klient NIE trzyma stanu domenowego (msg history, lista presence).
 * Tym zarządza App.tsx, który subskrybuje eventy.
 */

// ─────────────────────────────────── Wire types

export type TypingState = "start" | "stop";

export type ClientEvent =
  | { type: "send"; to: string; body: string; client_msg_id?: string }
  | { type: "typing"; to: string; state: TypingState }
  | { type: "ack_delivery"; message_id: string }
  | { type: "ack_blob"; blob_id: string }
  | { type: "ack_welcome"; welcome_id: string }
  | {
      type: "send_blob";
      to: string;
      group_id: string;
      epoch: number;
      ciphertext: string;
      client_msg_id?: string;
    }
  | { type: "send_welcome"; to: string; ciphertext: string }
  | { type: "ping" };

export type ServerEvent =
  | { type: "ready"; account_id: string; username: string }
  | {
      type: "message";
      id: string;
      from: string;
      body: string;
      created_at: string;
    }
  | {
      type: "sent";
      id: string;
      client_msg_id: string | null;
      to: string;
      created_at: string;
    }
  | { type: "typing"; from: string; state: TypingState }
  | { type: "presence"; username: string; online: boolean }
  | {
      type: "blob";
      id: string;
      from: string;
      group_id: string;
      epoch: number;
      ciphertext: string;
      created_at: string;
    }
  | {
      type: "sent_blob";
      id: string;
      client_msg_id: string | null;
      to: string;
      created_at: string;
    }
  | {
      type: "welcome";
      id: string;
      from: string;
      ciphertext: string;
      created_at: string;
    }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

// ─────────────────────────────────── Status

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; account_id: string; username: string }
  | { kind: "reconnecting"; nextAttemptInMs: number; attempt: number }
  | { kind: "error"; message: string };

type Listener = (event: ServerEvent) => void;
type StatusListener = (status: ConnectionStatus) => void;

// ─────────────────────────────────── NetworkClient

interface ClientConfig {
  serverUrl: string;
  token: string;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const PING_INTERVAL_MS = 30000;

function wsUrl(serverUrl: string, token: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = (u.pathname.replace(/\/+$/, "") || "") + "/ws";
  u.search = `?token=${encodeURIComponent(token)}`;
  return u.toString();
}

export class NetworkClient {
  private cfg: ClientConfig;
  private socket: WebSocket | null = null;
  private listeners: Set<Listener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private status: ConnectionStatus = { kind: "idle" };
  /** Bufor wychodzących wiadomości na czas, gdy WS nie jest jeszcze gotowy. */
  private outbox: ClientEvent[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private intentionallyClosed = false;

  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
  }

  /** Podmień config bez disconnectu — przyda się do hot-swap server URL. */
  updateConfig(cfg: ClientConfig): void {
    const same =
      this.cfg.serverUrl === cfg.serverUrl && this.cfg.token === cfg.token;
    this.cfg = cfg;
    if (!same) {
      this.reconnect();
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Wyślij event. Jeśli WS niegotowe, kolejkuj. */
  send(event: ClientEvent): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    } else {
      this.outbox.push(event);
    }
  }

  connect(): void {
    if (!this.cfg.token || !this.cfg.serverUrl) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.intentionallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer != null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.setStatus({ kind: "idle" });
  }

  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  // ── private

  private openSocket(): void {
    this.setStatus({ kind: "connecting" });

    let url: string;
    try {
      url = wsUrl(this.cfg.serverUrl, this.cfg.token);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus({ kind: "error", message: `zły serverUrl: ${message}` });
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus({ kind: "error", message });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      // status zostanie ustawiony na 'connected' dopiero po `Ready` od serwera,
      // bo dopiero wtedy znamy account_id/username dla pewności.
      this.startPing();
      this.flushOutbox();
    };

    socket.onmessage = (e) => {
      let parsed: ServerEvent | null = null;
      try {
        parsed = JSON.parse(e.data) as ServerEvent;
      } catch {
        console.warn("[network] non-JSON frame ignored");
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      this.handleServerEvent(parsed);
    };

    socket.onerror = (e) => {
      console.warn("[network] ws error", e);
    };

    socket.onclose = (e) => {
      this.stopPing();
      this.socket = null;
      if (this.intentionallyClosed) {
        this.setStatus({ kind: "idle" });
        return;
      }
      // Code 1008 (Policy Violation) używamy domyślnie dla 401 (zły token),
      // ale serwer właściwie zamknie z 401 przed upgrade — wtedy nie dojdziemy
      // tutaj. Zostawiamy generic reconnect.
      const message =
        e.code === 1000 ? "zamknięte" : `zamknięte (code ${e.code})`;
      this.setStatus({ kind: "error", message });
      this.scheduleReconnect();
    };
  }

  private handleServerEvent(event: ServerEvent): void {
    if (event.type === "ready") {
      this.setStatus({
        kind: "connected",
        account_id: event.account_id,
        username: event.username,
      });
    }
    // UWAGA: auto-ack zostal ZDJETY. Klient (App.tsx) sam odpala ack po
    // SUKCESIE przetworzenia. Powod: jeli ack idzie przed processem (np.
    // welcome zostal acked, ale mls_process_welcome padl), server marks
    // delivered=true i juz nie repleyuje. Bez welcome na storage nigdy
    // nie zdeszyfrujemy zadnego blob-a (bedzie 'grupa nie istnieje').
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error("[network] listener threw", e);
      }
    }
  }

  private flushOutbox(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const ev of queued) {
      this.socket.send(JSON.stringify(ev));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          // ignore
        }
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer != null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (!this.cfg.token) return;
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx];
    this.reconnectAttempt += 1;
    this.setStatus({
      kind: "reconnecting",
      nextAttemptInMs: delay,
      attempt: this.reconnectAttempt,
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const l of this.statusListeners) {
      try {
        l(status);
      } catch (e) {
        console.error("[network] status listener threw", e);
      }
    }
  }
}

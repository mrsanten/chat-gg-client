import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import { PRODUCTION_SERVER_URL, saveSettings } from "../lib/settings";
import * as serverApi from "../lib/serverApi";
import type { ConnectionStatus, NetworkStats } from "../lib/network";
import type { Settings } from "../types";

interface Props {
  open: boolean;
  /** Tryb wymuszony — bez X w titlebarze, bez Anuluj. Boot apki gdy nie zalogowany. */
  forced?: boolean;
  settings: Settings;
  /** Status WS — pokazywany w trybie zalogowanym. */
  wsStatus?: ConnectionStatus;
  /** Live statystyki sieci — pokazywane gdy zalogowany. */
  netStats?: NetworkStats;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

type Mode = "login" | "register";

export function NetworkAccountDialog({
  open,
  forced,
  settings,
  wsStatus,
  netStats,
  onClose,
  onSaved,
}: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const serverUrl = PRODUCTION_SERVER_URL;

  useEffect(() => {
    if (!open) return;
    setMode("login");
    setUsername("");
    setPassword("");
    setShowPassword(false);
    setErr(null);
  }, [open]);

  if (!open) return null;

  const isLoggedIn = settings.network.token.length > 0 && !!settings.network.username;

  const persistAuth = async (resp: serverApi.AuthResponse, plainPassword: string) => {
    const next: Settings = {
      ...settings,
      network: {
        ...settings.network,
        server_url: serverUrl,
        token: resp.token,
        account_id: resp.account.id,
        username: resp.account.username,
        password: plainPassword,
      },
    };
    await saveSettings(next);
    onSaved(next);
  };

  const submit = async () => {
    setErr(null);
    if (!username.trim() || !password) {
      setErr("Username i hasło są wymagane.");
      return;
    }
    setBusy(true);
    try {
      const resp =
        mode === "login"
          ? await serverApi.login(serverUrl, username.trim(), password)
          : await serverApi.register(serverUrl, username.trim(), password);
      await persistAuth(resp, password);
      onClose();
    } catch (e) {
      const msg =
        e instanceof serverApi.ServerError
          ? e.code === "unauthorized"
            ? "Nieprawidłowy username lub hasło."
            : e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal gg-modal--wide">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Sieć</span>
          {!forced && (
            <div className="gg-chatwin-titlebar-buttons">
              <button
                className="gg-chatwin-titlebar-btn"
                onClick={onClose}
                aria-label="Zamknij"
              >
                <span className="gg-glyph gg-glyph--close" />
              </button>
            </div>
          )}
        </div>

        <div className="gg-modal-body">
          {isLoggedIn ? (
            <NetworkStatusPanel
              username={settings.network.username ?? ""}
              wsStatus={wsStatus}
              netStats={netStats}
            />
          ) : (
            <>
              {forced && (
                <p className="gg-hint">
                  Zaloguj się do sieci Gaidu, żeby korzystać z apki. Hasło zostanie
                  zapamiętane lokalnie — przy następnym uruchomieniu połączymy się
                  automatycznie.
                </p>
              )}

              <fieldset className="gg-fieldset">
                <legend>{mode === "login" ? "Logowanie" : "Rejestracja"}</legend>
                <div className="gg-field">
                  <input
                    type="text"
                    className="gg-text-input"
                    placeholder="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="gg-field">
                  <input
                    type={showPassword ? "text" : "password"}
                    className="gg-text-input"
                    placeholder={mode === "login" ? "hasło" : "hasło (8-128 znaków)"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="gg-mini-btn"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? "Ukryj" : "Pokaż"}
                  </button>
                </div>
                <p className="gg-hint">
                  {mode === "login" ? (
                    <>
                      Nie masz konta?{" "}
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setMode("register");
                          setErr(null);
                        }}
                      >
                        Zarejestruj się
                      </a>
                    </>
                  ) : (
                    <>
                      Masz już konto?{" "}
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setMode("login");
                          setErr(null);
                        }}
                      >
                        Zaloguj się
                      </a>
                    </>
                  )}
                </p>
              </fieldset>

              {err && <div className="gg-error">{err}</div>}
            </>
          )}
        </div>

        <div className="gg-modal-actions">
          {isLoggedIn ? (
            <button type="button" className="gg-btn" onClick={onClose}>
              Zamknij
            </button>
          ) : (
            <>
              {!forced && (
                <button type="button" className="gg-btn" onClick={onClose} disabled={busy}>
                  Anuluj
                </button>
              )}
              <button type="button" className="gg-send-btn" onClick={submit} disabled={busy}>
                <span>{busy ? "..." : mode === "login" ? "Zaloguj" : "Zarejestruj"}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────── Status panel

interface StatusPanelProps {
  username: string;
  wsStatus?: ConnectionStatus;
  netStats?: NetworkStats;
}

function NetworkStatusPanel({ username, wsStatus, netStats }: StatusPanelProps) {
  const status = wsStatus?.kind ?? "idle";
  const statusText =
    status === "connected"
      ? "Połączony"
      : status === "connecting"
        ? "Łączenie…"
        : status === "reconnecting"
          ? `Ponawiam połączenie (próba ${wsStatus && wsStatus.kind === "reconnecting" ? wsStatus.attempt : "?"})…`
          : status === "error"
            ? `Błąd: ${wsStatus && wsStatus.kind === "error" ? wsStatus.message : "?"}`
            : "Bezczynny";
  const statusClass =
    status === "connected"
      ? "ok"
      : status === "connecting" || status === "reconnecting"
        ? "warn"
        : "down";

  return (
    <>
      <fieldset className="gg-fieldset">
        <legend>Tożsamość</legend>
        <p>
          Zalogowany jako <strong>{username}</strong>
        </p>
        <p className="gg-hint">
          Wylogowanie znajdziesz w menu „Gaidu" w pasku górnym.
        </p>
      </fieldset>

      <fieldset className="gg-fieldset">
        <legend>Połączenie</legend>
        <div className="gg-net-status-row">
          <span className={`gg-net-status-dot gg-net-status-dot--${statusClass}`} aria-hidden />
          <span className="gg-net-status-label">{statusText}</span>
        </div>
        {netStats?.lastConnectedAt && status === "connected" && (
          <p className="gg-hint">
            Aktywne od {new Date(netStats.lastConnectedAt).toLocaleTimeString()}
          </p>
        )}
      </fieldset>

      <fieldset className="gg-fieldset">
        <legend>Statystyki</legend>
        <div className="gg-net-stats-grid">
          <Stat label="Ping" value={netStats?.lastPingMs != null ? `${netStats.lastPingMs} ms` : "—"} />
          <Stat
            label="Średnia (60 sample)"
            value={
              netStats && netStats.pingHistoryMs.length > 0
                ? `${avg(netStats.pingHistoryMs).toFixed(0)} ms`
                : "—"
            }
          />
          <Stat label="Frames in" value={netStats?.framesIn ?? 0} />
          <Stat label="Frames out" value={netStats?.framesOut ?? 0} />
          <Stat label="Reconnect-y" value={netStats?.reconnectCount ?? 0} />
          <Stat label="Outbox" value={netStats?.outboxSize ?? 0} />
        </div>
        <PingChart history={netStats?.pingHistoryMs ?? []} />
      </fieldset>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="gg-net-stat">
      <span className="gg-net-stat-label">{label}</span>
      <span className="gg-net-stat-value">{value}</span>
    </div>
  );
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

interface PingChartProps {
  history: number[];
}

/**
 * Mały SVG line chart pokazujący ostatnie ~60 sample-ów RTT (ms).
 * Skala Y dynamiczna: max(history, 100) jako ceiling.
 */
function PingChart({ history }: PingChartProps) {
  const w = 360;
  const h = 60;
  const padding = 4;
  const max = Math.max(100, ...history);

  const innerW = w - padding * 2;
  const innerH = h - padding * 2;
  const stepX = history.length > 1 ? innerW / (history.length - 1) : 0;

  const path = history
    .map((rtt, i) => {
      const x = padding + i * stepX;
      const y = padding + innerH - (rtt / max) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="gg-ping-chart-wrap">
      <svg
        className="gg-ping-chart"
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Wykres ping w czasie"
      >
        <rect x="0" y="0" width={w} height={h} fill="#fbf9ee" stroke="var(--xp-face-shadow)" />
        {history.length >= 2 && (
          <path d={path} fill="none" stroke="var(--gg-green)" strokeWidth="1.5" />
        )}
        <text x={w - padding} y={padding + 9} fontSize="9" textAnchor="end" fill="#666">
          {Math.round(max)} ms
        </text>
        <text x={padding} y={h - padding - 1} fontSize="9" fill="#666">
          0 ms
        </text>
      </svg>
      <p className="gg-hint">
        {history.length === 0
          ? "Czekam na pierwszy ping…"
          : `Ostatnie ${history.length} pingów (sample co 30 s).`}
      </p>
    </div>
  );
}

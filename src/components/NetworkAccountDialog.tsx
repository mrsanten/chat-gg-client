import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import { saveSettings } from "../lib/settings";
import * as serverApi from "../lib/serverApi";
import type { Settings } from "../types";

interface Props {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

type Mode = "login" | "register";

export function NetworkAccountDialog({ open, settings, onClose, onSaved }: Props) {
  const [serverUrl, setServerUrl] = useState(settings.network.server_url);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [serverProbe, setServerProbe] = useState<"unknown" | "ok" | "down">("unknown");

  useEffect(() => {
    if (!open) return;
    setServerUrl(settings.network.server_url);
    setMode("login");
    setUsername("");
    setPassword("");
    setShowPassword(false);
    setErr(null);
    setServerProbe("unknown");
  }, [open, settings.network.server_url]);

  if (!open) return null;

  const isLoggedIn = settings.network.token.length > 0 && !!settings.network.username;

  const probeServer = async () => {
    setServerProbe("unknown");
    const ok = await serverApi.healthz(serverUrl);
    setServerProbe(ok ? "ok" : "down");
  };

  const persistAuth = async (resp: serverApi.AuthResponse) => {
    const next: Settings = {
      ...settings,
      network: {
        ...settings.network,
        server_url: serverUrl,
        token: resp.token,
        account_id: resp.account.id,
        username: resp.account.username,
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
      await persistAuth(resp);
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

  const logout = async () => {
    setBusy(true);
    try {
      const next: Settings = {
        ...settings,
        network: {
          ...settings.network,
          token: "",
          account_id: null,
          username: null,
        },
      };
      await saveSettings(next);
      onSaved(next);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Konto sieciowe</span>
          <div className="gg-chatwin-titlebar-buttons">
            <button className="gg-chatwin-titlebar-btn" onClick={onClose} aria-label="Zamknij">
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>

        <div className="gg-modal-body">
          {isLoggedIn ? (
            <>
              <fieldset className="gg-fieldset">
                <legend>Zalogowany</legend>
                <p>
                  <strong>{settings.network.username}</strong>
                </p>
                <p className="gg-hint">
                  Serwer: <code>{settings.network.server_url}</code>
                </p>
                <p className="gg-hint">
                  Po wylogowaniu sesja jest tylko czyszczona lokalnie. Token JWT
                  pozostaje ważny po stronie serwera do końca swojego TTL (30 dni
                  od wystawienia). Phase 1 nie ma jeszcze rewokacji tokenów.
                </p>
              </fieldset>
            </>
          ) : (
            <>
              <fieldset className="gg-fieldset">
                <legend>Serwer</legend>
                <div className="gg-field">
                  <input
                    type="text"
                    className="gg-text-input"
                    placeholder="http://localhost:8080"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                  />
                  <button type="button" className="gg-mini-btn" onClick={probeServer} disabled={busy}>
                    Sprawdź
                  </button>
                </div>
                {serverProbe === "ok" && (
                  <p className="gg-hint">✓ Serwer odpowiada na /healthz.</p>
                )}
                {serverProbe === "down" && (
                  <p className="gg-error">Serwer nie odpowiada (network/CORS/down).</p>
                )}
              </fieldset>

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
            <>
              <button type="button" className="gg-btn" onClick={onClose} disabled={busy}>
                Anuluj
              </button>
              <button type="button" className="gg-btn" onClick={logout} disabled={busy}>
                Wyloguj
              </button>
            </>
          ) : (
            <>
              <button type="button" className="gg-btn" onClick={onClose} disabled={busy}>
                Anuluj
              </button>
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

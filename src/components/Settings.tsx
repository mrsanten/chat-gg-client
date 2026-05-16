import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import { loadSettings, saveSettings } from "../lib/settings";
import { DEFAULT_SETTINGS, type Settings } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

type Tab = "general" | "ai";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "general", label: "Ogólne" },
  { id: "ai", label: "Konfiguracja AI" },
];

export function SettingsDialog({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("general");
  const [showAnth, setShowAnth] = useState(false);
  const [showOai, setShowOai] = useState(false);
  const [showMoon, setShowMoon] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setTab("general");
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, [open]);

  if (!open) return null;

  const setAnthMode = (mode: "none" | "api_key" | "claude_code") => {
    setSettings((s) => ({
      ...s,
      anthropic: {
        ...s.anthropic,
        auth:
          mode === "api_key"
            ? { mode: "api_key", api_key: s.anthropic.auth.mode === "api_key" ? s.anthropic.auth.api_key : "" }
            : mode === "claude_code"
              ? { mode: "claude_code", binary_path: s.anthropic.auth.mode === "claude_code" ? s.anthropic.auth.binary_path : null }
              : { mode: "none" },
      },
    }));
  };

  const setOaiMode = (mode: "none" | "api_key" | "codex") => {
    setSettings((s) => ({
      ...s,
      openai: {
        ...s.openai,
        auth:
          mode === "api_key"
            ? { mode: "api_key", api_key: s.openai.auth.mode === "api_key" ? s.openai.auth.api_key : "" }
            : mode === "codex"
              ? { mode: "codex", binary_path: s.openai.auth.mode === "codex" ? s.openai.auth.binary_path : null }
              : { mode: "none" },
      },
    }));
  };

  const setMoonMode = (mode: "none" | "api_key") => {
    setSettings((s) => ({
      ...s,
      moonshot: {
        ...s.moonshot,
        auth:
          mode === "api_key"
            ? {
                mode: "api_key",
                api_key: s.moonshot.auth.mode === "api_key" ? s.moonshot.auth.api_key : "",
                base_url: s.moonshot.auth.mode === "api_key" ? s.moonshot.auth.base_url : null,
              }
            : { mode: "none" },
      },
    }));
  };

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await saveSettings(settings);
      onSaved(settings);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const a = settings.anthropic.auth;
  const o = settings.openai.auth;
  const k = settings.moonshot.auth;

  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Ustawienia</span>
          <div className="gg-chatwin-titlebar-buttons">
            <button className="gg-chatwin-titlebar-btn" onClick={onClose} aria-label="Zamknij">
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>

        <div className="gg-modal-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className={`gg-modal-tab${tab === t.id ? " is-active" : ""}`}
              onClick={() => setTab(t.id)}
              aria-selected={tab === t.id}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="gg-modal-body">
          {!loaded && <div>Ładowanie...</div>}
          {loaded && tab === "general" && (
            <fieldset className="gg-fieldset">
              <legend>Wygląd</legend>
              <label className="gg-radio">
                <input
                  type="radio"
                  checked={(settings.theme ?? "light") === "light"}
                  onChange={() => setSettings((s) => ({ ...s, theme: "light" }))}
                />
                Jasny (XP Luna)
              </label>
              <label className="gg-radio">
                <input
                  type="radio"
                  checked={settings.theme === "dark"}
                  onChange={() => setSettings((s) => ({ ...s, theme: "dark" }))}
                />
                Ciemny
              </label>
              <label className="gg-radio">
                <input
                  type="radio"
                  checked={settings.theme === "system"}
                  onChange={() => setSettings((s) => ({ ...s, theme: "system" }))}
                />
                Według systemu
              </label>
            </fieldset>
          )}
          {loaded && tab === "ai" && (
            <>
              <fieldset className="gg-fieldset">
                <legend>Anthropic (Claude)</legend>
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={a.mode === "none"}
                    onChange={() => setAnthMode("none")}
                  />
                  Wyłączone
                </label>
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={a.mode === "api_key"}
                    onChange={() => setAnthMode("api_key")}
                  />
                  API key (console.anthropic.com)
                </label>
                {a.mode === "api_key" && (
                  <div className="gg-field">
                    <input
                      type={showAnth ? "text" : "password"}
                      className="gg-text-input"
                      placeholder="sk-ant-..."
                      value={a.api_key}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          anthropic: { ...s.anthropic, auth: { mode: "api_key", api_key: e.target.value } },
                        }))
                      }
                    />
                    <button type="button" className="gg-mini-btn" onClick={() => setShowAnth((v) => !v)}>
                      {showAnth ? "Ukryj" : "Pokaż"}
                    </button>
                  </div>
                )}
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={a.mode === "claude_code"}
                    onChange={() => setAnthMode("claude_code")}
                  />
                  Subskrypcja (Claude Code, używa Twojego loginu Pro/Max)
                </label>
                {a.mode === "claude_code" && (
                  <>
                    <div className="gg-field">
                      <input
                        type="text"
                        className="gg-text-input"
                        placeholder="claude (lub pełna ścieżka, np. /usr/local/bin/claude)"
                        value={a.binary_path ?? ""}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            anthropic: {
                              ...s.anthropic,
                              auth: { mode: "claude_code", binary_path: e.target.value || null },
                            },
                          }))
                        }
                      />
                    </div>
                    <p className="gg-hint">
                      Wymaga zainstalowanego Claude Code (`npm i -g @anthropic-ai/claude-code`) i zalogowania (`claude /login`). Apka shelluje do binarki.
                    </p>
                  </>
                )}
              </fieldset>

              <fieldset className="gg-fieldset">
                <legend>OpenAI (ChatGPT)</legend>
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={o.mode === "none"}
                    onChange={() => setOaiMode("none")}
                  />
                  Wyłączone
                </label>
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={o.mode === "api_key"}
                    onChange={() => setOaiMode("api_key")}
                  />
                  API key (platform.openai.com)
                </label>
                {o.mode === "api_key" && (
                  <div className="gg-field">
                    <input
                      type={showOai ? "text" : "password"}
                      className="gg-text-input"
                      placeholder="sk-..."
                      value={o.api_key}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          openai: { ...s.openai, auth: { mode: "api_key", api_key: e.target.value } },
                        }))
                      }
                    />
                    <button type="button" className="gg-mini-btn" onClick={() => setShowOai((v) => !v)}>
                      {showOai ? "Ukryj" : "Pokaż"}
                    </button>
                  </div>
                )}
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={o.mode === "codex"}
                    onChange={() => setOaiMode("codex")}
                  />
                  Subskrypcja (Codex CLI, używa Twojego loginu ChatGPT Plus/Pro/Business)
                </label>
                {o.mode === "codex" && (
                  <>
                    <div className="gg-field">
                      <input
                        type="text"
                        className="gg-text-input"
                        placeholder="codex (lub pełna ścieżka, np. /usr/local/bin/codex)"
                        value={o.binary_path ?? ""}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            openai: {
                              ...s.openai,
                              auth: { mode: "codex", binary_path: e.target.value || null },
                            },
                          }))
                        }
                      />
                    </div>
                    <p className="gg-hint">
                      Wymaga zainstalowanego Codex CLI (`npm i -g @openai/codex`) i zalogowania (`codex login` otworzy ChatGPT w przeglądarce). Apka shelluje do binarki w trybie `codex exec --json`. Klucz API z platform.openai.com nie jest potrzebny.
                    </p>
                  </>
                )}
                {o.mode !== "codex" && (
                  <p className="gg-hint">
                    Subskrypcja ChatGPT Plus/Pro nie udostępnia oficjalnego API. Aby używać GPT bez subskrypcji, potrzebujesz osobnego klucza API z platform.openai.com (rozliczany niezależnie). Jeśli masz aktywne ChatGPT Plus/Pro, użyj trybu „Subskrypcja (Codex CLI)" poniżej.
                  </p>
                )}
              </fieldset>

              <fieldset className="gg-fieldset">
                <legend>Moonshot (Kimi)</legend>
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={k.mode === "none"}
                    onChange={() => setMoonMode("none")}
                  />
                  Wyłączone
                </label>
                <label className="gg-radio">
                  <input
                    type="radio"
                    checked={k.mode === "api_key"}
                    onChange={() => setMoonMode("api_key")}
                  />
                  API key (platform.moonshot.ai)
                </label>
                {k.mode === "api_key" && (
                  <>
                    <div className="gg-field">
                      <input
                        type={showMoon ? "text" : "password"}
                        className="gg-text-input"
                        placeholder="sk-..."
                        value={k.api_key}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            moonshot: {
                              ...s.moonshot,
                              auth: {
                                mode: "api_key",
                                api_key: e.target.value,
                                base_url: k.base_url,
                              },
                            },
                          }))
                        }
                      />
                      <button type="button" className="gg-mini-btn" onClick={() => setShowMoon((v) => !v)}>
                        {showMoon ? "Ukryj" : "Pokaż"}
                      </button>
                    </div>
                    <div className="gg-field">
                      <input
                        type="text"
                        className="gg-text-input"
                        placeholder="Base URL (puste = https://api.moonshot.ai/v1, dla ChinComp: https://api.moonshot.cn/v1)"
                        value={k.base_url ?? ""}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            moonshot: {
                              ...s.moonshot,
                              auth: {
                                mode: "api_key",
                                api_key: k.api_key,
                                base_url: e.target.value || null,
                              },
                            },
                          }))
                        }
                      />
                    </div>
                  </>
                )}
              </fieldset>

              <p className="gg-hint">
                Sekrety zapisywane są lokalnie do pliku konfiguracyjnego apki (plain JSON, nie szyfrowane). Trzymaj komputer u siebie.
              </p>
            </>
          )}

          {err && <div className="gg-error">{err}</div>}
        </div>

        <div className="gg-modal-actions">
          <button type="button" className="gg-btn" onClick={onClose} disabled={saving}>
            Anuluj
          </button>
          <button
            type="button"
            className="gg-send-btn"
            onClick={onSave}
            disabled={saving || !loaded}
          >
            <span>{saving ? "Zapisywanie..." : "Zapisz"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

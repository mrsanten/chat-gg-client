import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";

interface Props {
  open: boolean;
  initialNick?: string;
  /**
   * Czy okno może być zamknięte bez podania nicka. `true` = pierwszy start
   * (tryb przymusowy), `false` = edycja z menu (można anulować).
   */
  required?: boolean;
  onSave: (nick: string) => Promise<void> | void;
  onCancel?: () => void;
}

export function ProfileDialog({ open, initialNick = "", required, onSave, onCancel }: Props) {
  const [nick, setNick] = useState(initialNick);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNick(initialNick);
      setErr(null);
    }
  }, [open, initialNick]);

  if (!open) return null;

  const trySave = async () => {
    const trimmed = nick.trim();
    if (trimmed.length === 0) {
      setErr("Nick nie może być pusty.");
      return;
    }
    if (trimmed.length > 32) {
      setErr("Nick nie może być dłuższy niż 32 znaki.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSave(trimmed);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">
            {required ? "Witaj w GAIdu GAIdu" : "Twój profil"}
          </span>
          {!required && (
            <div className="gg-chatwin-titlebar-buttons">
              <button
                className="gg-chatwin-titlebar-btn"
                onClick={onCancel}
                aria-label="Zamknij"
              >
                <span className="gg-glyph gg-glyph--close" />
              </button>
            </div>
          )}
        </div>
        <div className="gg-modal-body">
          {required && (
            <p className="gg-hint">
              Zanim zaczniesz pisać, podaj swój nick. Będzie wyświetlany w panelu po lewej stronie.
            </p>
          )}
          <fieldset className="gg-fieldset">
            <legend>Nick</legend>
            <div className="gg-field">
              <input
                type="text"
                className="gg-text-input"
                placeholder="Twój nick"
                value={nick}
                maxLength={32}
                autoFocus
                onChange={(e) => setNick(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void trySave();
                  }
                }}
              />
            </div>
            <p className="gg-hint">Maks. 32 znaki. Możesz zmienić później (Ustawienia).</p>
          </fieldset>
          {err && <div className="gg-error">{err}</div>}
        </div>
        <div className="gg-modal-actions">
          {!required && onCancel && (
            <button type="button" className="gg-btn" onClick={onCancel} disabled={saving}>
              Anuluj
            </button>
          )}
          <button
            type="button"
            className="gg-send-btn"
            onClick={trySave}
            disabled={saving}
          >
            <span>{saving ? "Zapisywanie…" : required ? "Zaczynamy" : "Zapisz"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

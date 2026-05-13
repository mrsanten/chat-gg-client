import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import type { ServerContact } from "../lib/serverApi";

interface Props {
  open: boolean;
  contacts: ServerContact[];
  onClose: () => void;
  onSubmit: (name: string, memberUsernames: string[]) => Promise<void>;
}

export function CreateGroupDialog({ open, contacts, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setSelected(new Set());
      setBusy(false);
      setErr(null);
    }
  }, [open]);

  if (!open) return null;

  const toggle = (username: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const submit = async () => {
    setErr(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Nazwa grupy jest wymagana.");
      return;
    }
    if (trimmed.length > 80) {
      setErr("Nazwa max 80 znaków.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed, Array.from(selected));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div className="gg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Nowa grupa</span>
          <div className="gg-chatwin-titlebar-buttons">
            <button
              className="gg-chatwin-titlebar-btn"
              onClick={onClose}
              aria-label="Zamknij"
            >
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>
        <div className="gg-modal-body">
          <fieldset className="gg-fieldset">
            <legend>Nazwa</legend>
            <div className="gg-field">
              <input
                type="text"
                className="gg-text-input"
                placeholder="np. Ekipa weekendowa"
                value={name}
                autoFocus
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </fieldset>
          <fieldset className="gg-fieldset">
            <legend>Członkowie</legend>
            {contacts.length === 0 ? (
              <div className="gg-field" style={{ color: "var(--text-mute)" }}>
                Brak znajomych. Dodaj kontakty zanim utworzysz grupę.
              </div>
            ) : (
              <div className="gg-creategroup-list">
                {contacts.map((c) => {
                  const checked = selected.has(c.username);
                  return (
                    <label key={c.peer_id} className="gg-creategroup-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(c.username)}
                      />
                      <span>{c.nickname?.trim() || c.username}</span>
                      {c.nickname && (
                        <span className="gg-creategroup-meta">
                          ({c.username})
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          {err && (
            <div className="gg-field" style={{ color: "var(--gg-orange)" }}>
              {err}
            </div>
          )}
          <div className="gg-modal-actions">
            <button
              type="button"
              className="gg-section-action"
              onClick={onClose}
              disabled={busy}
            >
              Anuluj
            </button>
            <button
              type="button"
              className="gg-section-action"
              onClick={() => void submit()}
              disabled={busy || !name.trim()}
            >
              {busy ? "Tworzę…" : "Utwórz grupę"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

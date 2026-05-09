import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import { addContact, ServerError, type ServerContact } from "../lib/serverApi";

interface Props {
  open: boolean;
  serverUrl: string;
  token: string;
  onClose: () => void;
  onAdded: (contact: ServerContact) => void;
}

export function AddFriendDialog({ open, serverUrl, token, onClose, onAdded }: Props) {
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUsername("");
      setNickname("");
      setBusy(false);
      setErr(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setErr(null);
    if (!username.trim()) {
      setErr("Username jest wymagany.");
      return;
    }
    setBusy(true);
    try {
      const contact = await addContact(
        serverUrl,
        token,
        username.trim(),
        nickname.trim() || undefined,
      );
      onAdded(contact);
      onClose();
    } catch (e) {
      const msg =
        e instanceof ServerError
          ? e.code === "not_found"
            ? `Użytkownik '${username}' nie istnieje na tym serwerze.`
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
      <div className="gg-modal">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Dodaj znajomego</span>
          <div className="gg-chatwin-titlebar-buttons">
            <button className="gg-chatwin-titlebar-btn" onClick={onClose} aria-label="Zamknij">
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>
        <div className="gg-modal-body">
          <fieldset className="gg-fieldset">
            <legend>Username</legend>
            <div className="gg-field">
              <input
                type="text"
                className="gg-text-input"
                placeholder="np. bob"
                value={username}
                autoFocus
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
            <p className="gg-hint">
              Case-insensitive. Druga strona automatycznie dostanie Cię w swojej liście znajomych.
            </p>
          </fieldset>
          <fieldset className="gg-fieldset">
            <legend>Nickname (opcjonalnie)</legend>
            <div className="gg-field">
              <input
                type="text"
                className="gg-text-input"
                placeholder="alias widoczny tylko dla Ciebie"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
          </fieldset>
          {err && <div className="gg-error">{err}</div>}
        </div>
        <div className="gg-modal-actions">
          <button type="button" className="gg-btn" onClick={onClose} disabled={busy}>
            Anuluj
          </button>
          <button type="button" className="gg-send-btn" onClick={submit} disabled={busy}>
            <span>{busy ? "Dodaję…" : "Dodaj"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

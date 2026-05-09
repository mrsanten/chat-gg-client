import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import { loadSettings, saveSettings } from "../lib/settings";
import { newMacroId, PLACEHOLDER } from "../lib/macros";
import { DEFAULT_SETTINGS, type Macro, type MacroMode, type Settings } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

export function MacrosDialog({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, [open]);

  if (!open) return null;

  const updateMacro = (id: string, patch: Partial<Macro>) => {
    setSettings((s) => ({
      ...s,
      macros: s.macros.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  };
  const removeMacro = (id: string) => {
    setSettings((s) => ({ ...s, macros: s.macros.filter((m) => m.id !== id) }));
  };
  const addMacro = (mode: MacroMode = "action") => {
    setSettings((s) => ({
      ...s,
      macros: [
        ...s.macros,
        {
          id: newMacroId(),
          name: mode === "session" ? "Nowy preset sesji" : "Nowe makro",
          template:
            mode === "session"
              ? "Odpowiadaj zwięźle, w punktach. Język: polski."
              : `Podmień mi ten tekst na styl amerykański lowercase i sprawdź, czy jest dobrze:\n\n${PLACEHOLDER}`,
          mode,
          auto_send: mode === "action" ? true : undefined,
        },
      ],
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

  const actions = settings.macros.filter((m) => (m.mode ?? "action") === "action");
  const sessions = settings.macros.filter((m) => m.mode === "session");

  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal gg-modal--wide">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Makra</span>
          <div className="gg-chatwin-titlebar-buttons">
            <button className="gg-chatwin-titlebar-btn" onClick={onClose} aria-label="Zamknij">
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>

        <div className="gg-modal-body">
          {!loaded && <div>Ładowanie...</div>}
          {loaded && (
            <>
              <fieldset className="gg-fieldset">
                <legend>Makra akcji (jednorazowe)</legend>
                <p className="gg-hint">
                  Pojawiają się jako przyciski nad polem wiadomości. Klik = podstaw <code>{PLACEHOLDER}</code> aktualnym tekstem composera (lub doklej szablon przed tekstem) i wyślij.
                </p>
                {actions.length === 0 && <p className="gg-hint">Brak. Dodaj pierwsze poniżej.</p>}
                {actions.map((m) => (
                  <MacroEditor
                    key={m.id}
                    macro={m}
                    onChange={(patch) => updateMacro(m.id, patch)}
                    onRemove={() => removeMacro(m.id)}
                  />
                ))}
                <button type="button" className="gg-mini-btn" onClick={() => addMacro("action")}>
                  + Dodaj makro akcji
                </button>
              </fieldset>

              <fieldset className="gg-fieldset">
                <legend>Presety sesji (per-chat)</legend>
                <p className="gg-hint">
                  Włączasz checkboxem dla danej rozmowy. Szablon jest dołączany <strong>niewidocznie</strong> przed każdą Twoją wiadomością wysyłaną do AI w tej sesji. Tekst nie pojawia się w composerze, kontekst widzi tylko model. Możesz mieć kilka aktywnych jednocześnie, ich szablony łączą się ze sobą.
                </p>
                {sessions.length === 0 && <p className="gg-hint">Brak. Dodaj pierwszy poniżej.</p>}
                {sessions.map((m) => (
                  <MacroEditor
                    key={m.id}
                    macro={m}
                    onChange={(patch) => updateMacro(m.id, patch)}
                    onRemove={() => removeMacro(m.id)}
                  />
                ))}
                <button type="button" className="gg-mini-btn" onClick={() => addMacro("session")}>
                  + Dodaj preset sesji
                </button>
              </fieldset>

              {err && <div className="gg-error">{err}</div>}
            </>
          )}
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

interface EditorProps {
  macro: Macro;
  onChange: (patch: Partial<Macro>) => void;
  onRemove: () => void;
}

function MacroEditor({ macro, onChange, onRemove }: EditorProps) {
  const isSession = macro.mode === "session";
  return (
    <div className="gg-macro-row">
      <div className="gg-field">
        <input
          type="text"
          className="gg-text-input"
          placeholder={isSession ? "Nazwa presetu" : "Nazwa makra"}
          value={macro.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button type="button" className="gg-mini-btn" onClick={onRemove} title="Usuń makro">
          Usuń
        </button>
      </div>
      <textarea
        className="gg-text-input gg-macro-textarea"
        rows={4}
        placeholder={
          isSession
            ? "Instrukcja dla AI dołączana do każdej wiadomości w tej sesji…"
            : `Szablon, np.:\nPodmień mi ten tekst na styl amerykański lowercase:\n${PLACEHOLDER}`
        }
        value={macro.template}
        onChange={(e) => onChange({ template: e.target.value })}
      />
      {!isSession && (
        <label className="gg-radio gg-macro-autosend">
          <input
            type="checkbox"
            checked={macro.auto_send ?? true}
            onChange={(e) => onChange({ auto_send: e.target.checked })}
          />
          Wyślij od razu po kliknięciu
        </label>
      )}
    </div>
  );
}

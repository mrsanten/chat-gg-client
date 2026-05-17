import { useEffect, useMemo, useState } from "react";

/** Pojedyncza notatka. Trzymana lokalnie (localStorage) — nie synchronizuje
 *  się z serwerem; to prywatny notatnik na tym urządzeniu. */
interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

const STORAGE_KEY = "gg.notes.v1";

function loadNotes(): Note[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch {
    return [];
  }
}

function saveNotes(notes: Note[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    /* localStorage pełny / niedostępny — notatka zostaje tylko w pamięci */
  }
}

function relTime(ts: number): string {
  const min = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (min < 1) return "teraz";
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} godz`;
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Moduł notatek — lista po lewej, edytor po prawej. Wypełnia obszar obok
 *  railu w nowym układzie. */
export function Notes() {
  const [notes, setNotes] = useState<Note[]>(() => loadNotes());
  const [activeId, setActiveId] = useState<string | null>(
    () => loadNotes()[0]?.id ?? null,
  );

  useEffect(() => {
    saveNotes(notes);
  }, [notes]);

  const sorted = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
    [notes],
  );
  const active = notes.find((n) => n.id === activeId) ?? null;

  const addNote = () => {
    const note: Note = {
      id: crypto.randomUUID(),
      title: "",
      body: "",
      updatedAt: Date.now(),
    };
    setNotes((prev) => [note, ...prev]);
    setActiveId(note.id);
  };

  const patchActive = (patch: Partial<Pick<Note, "title" | "body">>) => {
    if (!activeId) return;
    setNotes((prev) =>
      prev.map((n) =>
        n.id === activeId ? { ...n, ...patch, updatedAt: Date.now() } : n,
      ),
    );
  };

  const deleteNote = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (activeId === id) setActiveId(null);
  };

  return (
    <div className="gg-module gg-notes">
      <div className="gg-notes-list">
        <div className="gg-notes-list-head">
          <span className="gg-notes-list-title">Notatki</span>
          <button
            type="button"
            className="gg-section-action"
            onClick={addNote}
            title="Nowa notatka"
            aria-label="Nowa notatka"
          >
            +
          </button>
        </div>
        <div className="gg-notes-list-body">
          {sorted.length === 0 && (
            <div className="gg-notes-empty-list">
              Brak notatek. Kliknij „+", żeby utworzyć pierwszą.
            </div>
          )}
          {sorted.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`gg-notes-item${n.id === activeId ? " is-active" : ""}`}
              onClick={() => setActiveId(n.id)}
            >
              <span className="gg-notes-item-row">
                <span className="gg-notes-item-title">
                  {n.title.trim() || "Bez tytułu"}
                </span>
                <span className="gg-notes-item-time">{relTime(n.updatedAt)}</span>
              </span>
              <span className="gg-notes-item-preview">
                {n.body.trim().split("\n")[0] || "Pusta notatka"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="gg-notes-editor">
        {active ? (
          <>
            <div className="gg-notes-editor-head">
              <input
                className="gg-notes-title-input"
                value={active.title}
                placeholder="Tytuł notatki"
                maxLength={120}
                onChange={(e) => patchActive({ title: e.target.value })}
              />
              <button
                type="button"
                className="gg-btn"
                onClick={() => deleteNote(active.id)}
              >
                Usuń
              </button>
            </div>
            <textarea
              className="gg-notes-body-input"
              value={active.body}
              placeholder="Zacznij pisać…"
              onChange={(e) => patchActive({ body: e.target.value })}
            />
          </>
        ) : (
          <div className="gg-notes-empty">
            Wybierz notatkę z listy albo utwórz nową.
          </div>
        )}
      </div>
    </div>
  );
}

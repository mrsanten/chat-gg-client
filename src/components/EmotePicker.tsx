import { useEffect, useRef, useState } from "react";
import { EMOTES, EMOTES_BY_CATEGORY } from "../data/emotes";

interface Props {
  open: boolean;
  /** Anchor pod którym wyrender popover (zwykle przycisk). */
  anchor: HTMLElement | null;
  onClose: () => void;
  /** Wstawia trigger (np. `<haha>`) do composera. */
  onPick: (trigger: string) => void;
}

type Tab = "1" | "2" | "3";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "1", label: "GG7 cz.1" },
  { id: "2", label: "GG7 cz.2" },
  { id: "3", label: "GG7 cz.3" },
];

export function EmotePicker({ open, anchor, onClose, onPick }: Props) {
  const [tab, setTab] = useState<Tab>("1");
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Zamknij po Escape lub kliku poza popoverem.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, anchor]);

  // Reset filtra po zamknięciu, żeby kolejne otwarcie startowało od czysta.
  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  if (!open) return null;

  const q = filter.trim().toLowerCase();
  const triggers = q
    ? Object.keys(EMOTES)
        .filter((t) => t.toLowerCase().includes(q))
        .sort()
    : [...EMOTES_BY_CATEGORY[tab]];

  return (
    <div className="gg-emote-popover" ref={ref} role="dialog" aria-label="Emotki">
      <div className="gg-emote-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className={`gg-emote-tab${tab === t.id && !q ? " is-active" : ""}`}
            onClick={() => {
              setTab(t.id);
              setFilter("");
            }}
            aria-selected={tab === t.id && !q}
          >
            {t.label}
          </button>
        ))}
        <input
          type="text"
          className="gg-emote-search"
          placeholder="szukaj…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="gg-emote-grid">
        {triggers.length === 0 ? (
          <div className="gg-emote-empty">brak wyników</div>
        ) : (
          triggers.map((trigger) => {
            const path = EMOTES[trigger];
            return (
              <button
                key={trigger}
                type="button"
                className="gg-emote-cell"
                title={`<${trigger}>`}
                onClick={() => onPick(trigger)}
              >
                <img src={`/emotes/${path}`} alt={trigger} loading="lazy" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { EMOTES } from "../data/emotes";

interface Props {
  open: boolean;
  /** Anchor pod którym wyrender popover (zwykle przycisk). */
  anchor: HTMLElement | null;
  onClose: () => void;
  /** Wstawia trigger (np. `<haha>`) do composera. */
  onPick: (trigger: string) => void;
}

/**
 * Jedna lista emotek bez powtórzeń. GG7 cz.1/2/3 zawierają te same emotki
 * w różnych folderach — deduplikujemy po nazwie pliku, zostawiając pierwszy
 * (alfabetycznie) trigger dla danej grafiki.
 */
const UNIQUE_TRIGGERS: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const trigger of Object.keys(EMOTES).sort()) {
    const file = EMOTES[trigger].replace(/^[^/]+\//, "");
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(trigger);
  }
  return out;
})();

export function EmotePicker({ open, anchor, onClose, onPick }: Props) {
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
    ? UNIQUE_TRIGGERS.filter((t) => t.toLowerCase().includes(q))
    : UNIQUE_TRIGGERS;

  return (
    <div className="gg-emote-popover" ref={ref} role="dialog" aria-label="Emotki">
      <div className="gg-emote-tabs">
        <input
          type="text"
          className="gg-emote-search"
          placeholder="szukaj emotki…"
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

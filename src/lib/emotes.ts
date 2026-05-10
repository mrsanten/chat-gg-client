import { EMOTES } from "../data/emotes";

/**
 * Format triggera w wiadomości: `<name>` (dir 1), `<name2>` (dir 2),
 * `<name3>` (dir 3). Bardzo permisywny regex — pozwala na cyfry, _, -.
 * Greedy by default, ale ograniczone do max 32 znaków żeby przypadkowy
 * `<bardzo długi tekst>` nie przeskanował połowy linijki.
 */
const EMOTE_RE = /<([A-Za-z0-9_]{1,32})>/g;

export interface EmoteToken {
  kind: "text" | "emote";
  /** Dla text: surowy tekst. Dla emote: ścieżka pliku, np. "1/haha.gif". */
  value: string;
  /** Tylko dla emote: oryginalny trigger, np. "haha". */
  trigger?: string;
}

/**
 * Tokenizuje treść wiadomości. Każdy `<trigger>` znajduje się w mapie EMOTES
 * to osobny `emote` token; reszta to `text`. Nie-rozpoznane sekwencje
 * `<...>` zostają w tekście (np. `<3` czy URL `<https://...>`).
 */
export function tokenizeEmotes(text: string): EmoteToken[] {
  if (!text) return [];
  const tokens: EmoteToken[] = [];
  let lastIndex = 0;
  EMOTE_RE.lastIndex = 0;
  for (let m = EMOTE_RE.exec(text); m !== null; m = EMOTE_RE.exec(text)) {
    const trigger = m[1];
    const path = EMOTES[trigger];
    if (!path) continue;
    if (m.index > lastIndex) {
      tokens.push({ kind: "text", value: text.slice(lastIndex, m.index) });
    }
    tokens.push({ kind: "emote", value: path, trigger });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}

/** True jeśli `text` zawiera przynajmniej jeden rozpoznany emote. */
export function hasEmotes(text: string): boolean {
  EMOTE_RE.lastIndex = 0;
  for (let m = EMOTE_RE.exec(text); m !== null; m = EMOTE_RE.exec(text)) {
    if (EMOTES[m[1]]) return true;
  }
  return false;
}

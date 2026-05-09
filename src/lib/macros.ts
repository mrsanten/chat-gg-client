import type { Macro } from "../types";

export const PLACEHOLDER = "{input}";

export interface MacroResult {
  /** Tekst do wysłania lub do umieszczenia w composerze. */
  text: string;
  /** Czy wysłać od razu. False oznacza „wstaw do composera, czekaj na usera". */
  send: boolean;
  /**
   * Jeśli `send: false`, pozycja kursora w wynikowym tekście — tam gdzie był
   * placeholder lub na końcu tekstu.
   */
  caret: number;
}

/**
 * Łączy szablon makra z aktualnym tekstem composera.
 *
 * Reguły:
 * - Jeśli composer ma tekst i szablon zawiera `{input}`: podmień placeholder, wyślij.
 * - Jeśli composer ma tekst i szablon nie ma `{input}`: prepend `template + \n\n + input`, wyślij.
 * - Jeśli composer jest pusty i szablon ma `{input}`: wstaw szablon, kursor na pozycji placeholdera, nie wysyłaj.
 * - Jeśli composer jest pusty i szablon nie ma `{input}`: wstaw szablon, kursor na końcu, nie wysyłaj.
 *
 * `auto_send` w makrze może wymusić tryb „nigdy nie wysyłaj automatycznie".
 */
export function applyMacro(macro: Macro, currentText: string): MacroResult {
  const trimmed = currentText.trim();
  const hasPlaceholder = macro.template.includes(PLACEHOLDER);
  const autoSend = macro.auto_send ?? true;

  if (trimmed.length > 0) {
    const merged = hasPlaceholder
      ? macro.template.split(PLACEHOLDER).join(currentText)
      : `${macro.template}\n\n${currentText}`;
    return { text: merged, send: autoSend, caret: merged.length };
  }

  // composer pusty -> wstaw szablon do edycji
  if (hasPlaceholder) {
    const idx = macro.template.indexOf(PLACEHOLDER);
    const text = macro.template.replace(PLACEHOLDER, "");
    return { text, send: false, caret: idx };
  }
  return { text: macro.template, send: false, caret: macro.template.length };
}

export function newMacroId(): string {
  return "m-" + Math.random().toString(36).slice(2, 10);
}

/**
 * Buduje tekst wiadomości lecącej do AI z aktywnymi presetami sesji.
 * Każdy preset jest dodawany przed tekstem usera. Jeśli preset zawiera
 * `{input}`, placeholder jest podmieniany; w przeciwnym wypadku presety
 * są łączone i kładzione przed tekstem.
 *
 * Zwraca oryginalny tekst, gdy nie ma aktywnych presetów.
 */
export function augmentForApi(
  visibleText: string,
  activeSessionMacros: Macro[],
): string {
  if (activeSessionMacros.length === 0) return visibleText;

  let body = visibleText;
  const prefixes: string[] = [];

  for (const macro of activeSessionMacros) {
    if (macro.template.includes(PLACEHOLDER)) {
      // Preset z placeholderem owija aktualny body.
      body = macro.template.split(PLACEHOLDER).join(body);
    } else {
      prefixes.push(macro.template);
    }
  }

  if (prefixes.length === 0) return body;
  return `${prefixes.join("\n\n")}\n\n${body}`;
}

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import sunIcon from "../assets/sun.svg";
import type { ImageAttachment, Macro } from "../types";
import { applyMacro } from "../lib/macros";

interface Props {
  disabled?: boolean;
  isStreaming?: boolean;
  macros?: Macro[];
  activeSessionMacroIds?: string[];
  onToggleSessionMacro?: (id: string) => void;
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop?: () => void;
  /**
   * Callback do trackingu pisania. `true` gdy user zaczął pisać po przerwie,
   * `false` gdy idle 3s lub wysłał wiadomość. Phase 6: peer chat — wpinamy
   * to do WebSocket `typing` event.
   */
  onTypingChange?: (typing: boolean) => void;
}

const MAX_IMAGES = 6;

export function Composer({
  disabled,
  isStreaming,
  macros,
  activeSessionMacroIds,
  onToggleSessionMacro,
  onSend,
  onStop,
  onTypingChange,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);
  const typingTimerRef = useRef<number | null>(null);

  const stopTyping = () => {
    if (typingTimerRef.current != null) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      onTypingChange?.(false);
    }
  };

  const noteKeystroke = () => {
    if (!onTypingChange) return;
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      onTypingChange(true);
    }
    if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(stopTyping, 3000);
  };

  useEffect(() => {
    return () => {
      if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
      if (typingActiveRef.current) {
        typingActiveRef.current = false;
        onTypingChange?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = Math.floor(window.innerHeight / 2);
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    if (pendingCaretRef.current != null) {
      const pos = pendingCaretRef.current;
      pendingCaretRef.current = null;
      el.focus();
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        // ignore
      }
    }
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    stopTyping();
    onSend(trimmed, images);
    setText("");
    setImages([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: ImageAttachment[] = [];
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const dataUrl = await blobToDataUrl(blob);
      const parsed = parseDataUrl(dataUrl);
      if (parsed) pasted.push(parsed);
    }
    if (pasted.length === 0) return;
    e.preventDefault();
    setImages((prev) => [...prev, ...pasted].slice(0, MAX_IMAGES));
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const runMacro = (macro: Macro) => {
    if (disabled) return;
    const result = applyMacro(macro, text);
    if (result.send) {
      const carriedImages = images;
      onSend(result.text, carriedImages);
      setText("");
      setImages([]);
    } else {
      pendingCaretRef.current = result.caret;
      setText(result.text);
    }
  };

  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;

  const actionMacros = (macros ?? []).filter((m) => (m.mode ?? "action") === "action");
  const sessionMacros = (macros ?? []).filter((m) => m.mode === "session");
  const activeSet = new Set(activeSessionMacroIds ?? []);

  return (
    <div className="gg-composer">
      {(actionMacros.length > 0 || sessionMacros.length > 0) && (
        <div className="gg-macro-bar" role="toolbar" aria-label="Makra">
          {actionMacros.map((m) => (
            <button
              key={m.id}
              type="button"
              className="gg-macro-chip"
              onClick={() => runMacro(m)}
              disabled={disabled}
              title={m.template}
            >
              <span className="gg-macro-chip-spark" aria-hidden>
                ✦
              </span>
              <span className="gg-macro-chip-label">{m.name}</span>
            </button>
          ))}
          {sessionMacros.length > 0 && actionMacros.length > 0 && (
            <span className="gg-macro-bar-sep" aria-hidden />
          )}
          {sessionMacros.map((m) => {
            const active = activeSet.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                className={`gg-macro-toggle${active ? " is-active" : ""}`}
                onClick={() => onToggleSessionMacro?.(m.id)}
                title={`${active ? "Wyłącz" : "Włącz"} dla tej sesji:\n${m.template}`}
                aria-pressed={active}
              >
                <span className="gg-macro-toggle-box" aria-hidden>
                  {active ? "✓" : ""}
                </span>
                <span className="gg-macro-chip-label">{m.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {images.length > 0 && (
        <div className="gg-composer-attachments">
          {images.map((img, idx) => (
            <div key={idx} className="gg-attachment">
              <img src={`data:${img.mimeType};base64,${img.base64}`} alt="" />
              <button
                type="button"
                className="gg-attachment-remove"
                onClick={() => removeImage(idx)}
                title="Usuń"
                aria-label="Usuń obrazek"
              >
                <span className="gg-glyph gg-glyph--close" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="gg-composer-row">
        <textarea
          ref={ref}
          className="gg-composer-input"
          rows={2}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.length > 0) noteKeystroke();
            else stopTyping();
          }}
          onBlur={stopTyping}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            images.length > 0
              ? "Dodaj komentarz albo wyślij sam obrazek..."
              : "Cmd+V żeby wkleić obrazek..."
          }
        />
        {isStreaming ? (
          <button
            type="button"
            className="gg-stop-btn"
            onClick={onStop}
            title="Zatrzymaj odpowiedź"
          >
            <span className="gg-stop-icon" aria-hidden />
            <span>Zatrzymaj</span>
          </button>
        ) : (
          <button
            type="button"
            className="gg-send-btn"
            onClick={submit}
            disabled={!canSend}
          >
            <img src={sunIcon} alt="" />
            <span>Wyślij</span>
          </button>
        )}
      </div>
    </div>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function parseDataUrl(dataUrl: string): ImageAttachment | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

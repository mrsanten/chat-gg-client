import { useState, useRef, useEffect, useLayoutEffect } from "react";
import sunIcon from "../assets/sun.svg";
import type { ImageAttachment } from "../types";

interface Props {
  disabled?: boolean;
  isStreaming?: boolean;
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop?: () => void;
}

const MAX_IMAGES = 6;

export function Composer({ disabled, isStreaming, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

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
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
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

  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;

  return (
    <div className="gg-composer">
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
          onChange={(e) => setText(e.target.value)}
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

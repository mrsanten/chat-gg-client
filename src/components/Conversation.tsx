import { useEffect, useRef, useState } from "react";
import sunIcon from "../assets/sun.svg";
import type { ChatMessage, ToolModel } from "../types";
import { MessageBody } from "./MessageBody";

interface Props {
  model: ToolModel;
  messages: ChatMessage[];
  sessionTitle?: string | null;
}

export function Conversation({ model, messages, sessionTitle }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="gg-chatwin">
      <div className="gg-chatwin-titlebar">
        <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
        <span className="gg-chatwin-titlebar-text">
          {model.name}
          {sessionTitle ? <span className="gg-chatwin-subtitle"> — {sessionTitle}</span> : null}
        </span>
        <div className="gg-chatwin-titlebar-buttons">
          <button className="gg-chatwin-titlebar-btn" tabIndex={-1}>
            <span className="gg-glyph gg-glyph--min" />
          </button>
          <button className="gg-chatwin-titlebar-btn" tabIndex={-1}>
            <span className="gg-glyph gg-glyph--max" />
          </button>
          <button className="gg-chatwin-titlebar-btn" tabIndex={-1}>
            <span className="gg-glyph gg-glyph--close" />
          </button>
        </div>
      </div>
      <div className="gg-conversation" ref={ref}>
        {messages.map((m) => (
          <Message key={m.id} msg={m} modelName={model.name} />
        ))}
      </div>
    </div>
  );
}

function Message({ msg, modelName }: { msg: ChatMessage; modelName: string }) {
  const isUser = msg.role === "user";
  const [copied, setCopied] = useState(false);

  const onCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(msg.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const showCopy = !msg.streaming && msg.text.trim().length > 0;

  return (
    <div className={`gg-msg ${isUser ? "gg-msg--user" : "gg-msg--ai"}`}>
      <div className="gg-msg-avatar">
        {!isUser && <img src={sunIcon} alt="" />}
      </div>
      <div className={`gg-msg-bubble ${isUser ? "gg-msg-bubble--user" : "gg-msg-bubble--ai"}`}>
        {!isUser && <div className="gg-msg-author">{modelName}</div>}
        {msg.images && msg.images.length > 0 && (
          <div className="gg-msg-attachments">
            {msg.images.map((img, idx) => (
              <img
                key={idx}
                className="gg-msg-attachment"
                src={`data:${img.mimeType};base64,${img.base64}`}
                alt=""
              />
            ))}
          </div>
        )}
        <MessageBody text={msg.text} streaming={msg.streaming} />
        {showCopy && (
          <button
            type="button"
            className="gg-msg-copy"
            onClick={onCopyMessage}
            title="Kopiuj treść"
          >
            {copied ? "Skopiowano" : "Kopiuj"}
          </button>
        )}
      </div>
      <span className="gg-msg-time">{msg.timestamp}</span>
    </div>
  );
}

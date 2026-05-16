import { useEffect, useRef, useState } from "react";
import sunIcon from "../assets/sun.svg";
import type { ChatMessage, ToolModel } from "../types";
import { MessageBody } from "./MessageBody";

interface Props {
  model: ToolModel;
  messages: ChatMessage[];
  sessionTitle?: string | null;
  /** Peer presence — pokazujemy ikonę zamiast słońca w nagłówku czatu z kontaktem. */
  peerPresence?: "online" | "afk" | "push_reachable" | "offline" | "connecting" | null;
  /** Liczba nieprzeczytanych dla aktywnego peera; >0 włącza miganie ikony. */
  peerUnread?: number;
  /** True gdy to czat z kontaktem (nie z AI) — włącza render emotek. */
  peerChat?: boolean;
  /** Klik w nagłówek z avatarem peera otwiera profil. */
  onPeerProfileClick?: () => void;
}

export function Conversation({
  model,
  messages,
  sessionTitle,
  peerPresence,
  peerUnread,
  peerChat,
  onPeerProfileClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Dla AI tool zostaje słońce. Dla peera ikona presence (z opcjonalnym
  // mignięciem unread).
  const presenceClass = peerPresence
    ? peerPresence === "online"
      ? "gg-friend-dot--on"
      : peerPresence === "afk"
        ? "gg-friend-dot--afk"
        : peerPresence === "push_reachable"
          ? "gg-friend-dot--push"
          : peerPresence === "offline"
            ? "gg-friend-dot--off"
            : "gg-friend-dot--connecting"
    : null;
  const showUnreadBlink = !!peerPresence && (peerUnread ?? 0) > 0;

  const headerClickable = !!(peerPresence && onPeerProfileClick);

  return (
    <>
      <header
        className={`gg-chat-header${headerClickable ? " is-clickable" : ""}`}
        onClick={headerClickable ? onPeerProfileClick : undefined}
        role={headerClickable ? "button" : undefined}
        title={headerClickable ? "Pokaż profil" : undefined}
      >
        {peerPresence ? (
          <span className="gg-chat-header-icon gg-friend-dot-wrap" aria-hidden>
            <span className={`gg-friend-dot ${presenceClass}`} />
            {showUnreadBlink && (
              <span className="gg-friend-dot gg-friend-dot--unread gg-friend-dot--blink" />
            )}
          </span>
        ) : (
          <img src={sunIcon} alt="" className="gg-chat-header-icon gg-chat-header-icon--ai" />
        )}
        <div className="gg-chat-header-text">
          <span className="gg-chat-header-title">{model.name}</span>
          {sessionTitle ? (
            <span className="gg-chat-header-sub">{sessionTitle}</span>
          ) : null}
        </div>
      </header>
      <div className="gg-conversation" ref={ref}>
        {messages.map((m) => (
          <Message key={m.id} msg={m} modelName={model.name} emotes={peerChat} />
        ))}
      </div>
    </>
  );
}

function Message({
  msg,
  modelName,
  emotes,
}: {
  msg: ChatMessage;
  modelName: string;
  emotes?: boolean;
}) {
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
        <MessageBody text={msg.text} streaming={msg.streaming} emotes={emotes} />
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
      <span className="gg-msg-time">
        {msg.e2e && (
          <span
            className="gg-msg-e2e"
            title="Zaszyfrowane end-to-end (MLS)"
            aria-label="Zaszyfrowane E2E"
          >
            🔒
          </span>
        )}
        {msg.timestamp}
      </span>
    </div>
  );
}

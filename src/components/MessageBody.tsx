import { Fragment, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "../lib/highlight";
import { tokenizeEmotes } from "../lib/emotes";

interface Props {
  text: string;
  streaming?: boolean;
  /** Włącza render emotek `<name>`/`<name2>`/`<name3>` zamiast markdownu.
   *  Dla peer chat (czat z człowiekiem) — true; AI chat — false (markdown). */
  emotes?: boolean;
}

export function MessageBody({ text, streaming, emotes }: Props) {
  if (emotes) {
    // Plain text + emote substitution. Bez markdownu — peer chat to zwykły
    // tekst, a `<jakiś_tag>` ma trafiać w nasz parser, nie w MD.
    const tokens = tokenizeEmotes(text);
    return (
      <div className="gg-msg-body gg-msg-body--plain">
        {tokens.map((t, i) =>
          t.kind === "emote" ? (
            <img
              key={i}
              className="gg-emote"
              src={`/emotes/${t.value}`}
              alt={`<${t.trigger}>`}
              title={`<${t.trigger}>`}
              loading="lazy"
            />
          ) : (
            <Fragment key={i}>{t.value}</Fragment>
          ),
        )}
        {streaming && <span className="gg-cursor" aria-hidden />}
      </div>
    );
  }
  return (
    <div className="gg-msg-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...rest }) => {
            const langMatch = /language-([\w-]+)/.exec(className ?? "");
            const isBlock = Boolean(langMatch);
            if (!isBlock) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            const raw = String(children).replace(/\n$/, "");
            return <CodeBlock lang={langMatch![1].toLowerCase()} text={raw} />;
          },
          pre: ({ children }) => <Fragment>{children}</Fragment>,
          img: ({ src, alt }) => (
            <span className="gg-msg-image-wrap">
              <img className="gg-msg-image" src={src as string} alt={alt ?? ""} loading="lazy" />
            </span>
          ),
          a: ({ href, children }) => (
            <a href={href as string} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="gg-cursor" aria-hidden />}
    </div>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const tokens = highlight(text, lang);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="gg-codeblock">
      <div className="gg-codeblock-bar">
        <span className="gg-codeblock-lang">{lang || "kod"}</span>
        <button type="button" className="gg-copy-btn" onClick={onCopy}>
          {copied ? "Skopiowano" : "Kopiuj"}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((t, ti) =>
            t.cls ? (
              <span key={ti} className={t.cls}>{t.text}</span>
            ) : (
              <Fragment key={ti}>{t.text}</Fragment>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

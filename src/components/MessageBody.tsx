import { Fragment, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "../lib/highlight";

interface Props {
  text: string;
  streaming?: boolean;
}

export function MessageBody({ text, streaming }: Props) {
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

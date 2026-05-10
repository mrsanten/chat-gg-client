import { useState } from "react";
import sunIcon from "../assets/sun.svg";
import type { SessionMeta, ToolModel } from "../types";
import type { ServerContact } from "../lib/serverApi";

interface Props {
  models: ToolModel[];
  activeModelId: string;
  onSelectModel: (id: string) => void;
  configuredByModel: Record<string, boolean>;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  nick?: string;
  /**
   * Status presencji do wyświetlenia pod nickiem. Komponuje się z stanem
   * sieciowym (zalogowany/łączenie/online).
   */
  presence?: "online" | "afk" | "connecting" | "offline" | "logged_out";
  // Phase 2B.2: lista znajomych. Pokazujemy tylko gdy networkLoggedIn.
  networkLoggedIn?: boolean;
  contacts?: ServerContact[];
  activePeerUsername?: string | null;
  onSelectPeer?: (username: string) => void;
  onAddFriend?: () => void;
  onRemoveFriend?: (contact: ServerContact) => void;
  /** Mapa username -> liczba nieprzeczytanych. Reset gdy wybierzesz peera. */
  unreadByPeer?: Record<string, number>;
  /** Opis z profilu zalogowanego usera (z serwera). Editowalny przez input. */
  description?: string;
  /** Wywoływane gdy user zmieni description; rodzic powinien debounce-ować save. */
  onDescriptionChange?: (description: string) => void;
}

export function Sidebar(props: Props) {
  const {
    models,
    activeModelId,
    onSelectModel,
    configuredByModel,
    sessions,
    activeSessionId,
    onSelectSession,
    onNewSession,
    onDeleteSession,
    nick,
    presence,
    networkLoggedIn,
    contacts,
    activePeerUsername,
    onSelectPeer,
    onAddFriend,
    onRemoveFriend,
    unreadByPeer,
    description,
    onDescriptionChange,
  } = props;

  const [openTools, setOpenTools] = useState(true);
  const [openHistory, setOpenHistory] = useState(true);
  const [openFriends, setOpenFriends] = useState(true);

  const activeModel = models.find((m) => m.id === activeModelId);
  const modelSessions = sessions.filter((s) => s.modelId === activeModelId);

  return (
    <aside className="gg-sidebar">
      <div className="gg-profile">
        <div className="gg-profile-avatar">
          <div className="gg-profile-avatar-frame">
            <img src={sunIcon} alt="" />
          </div>
        </div>
        <div className="gg-profile-info">
          <div className="gg-profile-name">
            {nick && nick.trim().length > 0 ? nick : "Użytkownik"}
          </div>
          <div className={`gg-profile-status gg-profile-status--${presence ?? "logged_out"}`}>
            {presence === "online"
              ? "Dostępny"
              : presence === "afk"
                ? "Zaraz wracam"
                : presence === "connecting"
                  ? "Łączenie…"
                  : presence === "offline"
                    ? "Brak połączenia"
                    : "Niezalogowany"}
          </div>
          <input
            className="gg-profile-desc"
            placeholder="Wpisz opis..."
            value={description ?? ""}
            maxLength={200}
            onChange={(e) => onDescriptionChange?.(e.target.value)}
            disabled={!onDescriptionChange}
          />
        </div>
      </div>

      <Section
        title="Narzędzia (CLI)"
        open={openTools}
        onToggle={() => setOpenTools((v) => !v)}
      >
        {models.map((m) => {
          const ok = configuredByModel[m.id] === true;
          return (
            <div
              key={m.id}
              className={`gg-tool-item${m.id === activeModelId && !activePeerUsername ? " is-active" : ""}`}
              onClick={() => onSelectModel(m.id)}
            >
              <span className="gg-tool-item-icon" aria-hidden />
              <span className="gg-tool-item-name">{m.name}</span>
              <span
                className={`gg-tool-item-status ${ok ? "gg-tool-item-status--on" : "gg-tool-item-status--off"}`}
                title={ok ? "Skonfigurowane" : "Brak konfiguracji - otwórz Ustawienia"}
              />
            </div>
          );
        })}
      </Section>

      {networkLoggedIn && (
        <Section
          title="Znajomi"
          count={contacts && contacts.length > 0 ? `(${contacts.filter((c) => c.online).length}/${contacts.length})` : undefined}
          open={openFriends}
          onToggle={() => setOpenFriends((v) => !v)}
          action={
            <button
              type="button"
              className="gg-section-action"
              onClick={(e) => {
                e.stopPropagation();
                onAddFriend?.();
              }}
              title="Dodaj znajomego po username"
            >
              + Dodaj
            </button>
          }
        >
          {(!contacts || contacts.length === 0) && (
            <div className="gg-history-empty">Brak znajomych. Kliknij „+ Dodaj" żeby zaprosić kogoś po username.</div>
          )}
          {contacts?.map((c) => {
            const unread = unreadByPeer?.[c.username] ?? 0;
            const displayName =
              c.nickname && c.nickname.trim().length > 0 ? c.nickname : c.username;
            const peerDesc = c.description?.trim() ?? "";
            return (
              <div
                key={c.peer_id}
                className={`gg-friend-item${activePeerUsername === c.username ? " is-active" : ""}`}
                onClick={() => onSelectPeer?.(c.username)}
                title={
                  peerDesc
                    ? `${c.online ? "Online" : "Offline"}\n${peerDesc}`
                    : c.online
                      ? "Online"
                      : "Offline"
                }
              >
                <span className="gg-friend-dot-wrap" aria-hidden>
                  <span
                    className={`gg-friend-dot ${
                      c.status === "afk"
                        ? "gg-friend-dot--afk"
                        : c.online
                          ? "gg-friend-dot--on"
                          : "gg-friend-dot--off"
                    }`}
                  />
                  {unread > 0 && (
                    <span className="gg-friend-dot gg-friend-dot--unread gg-friend-dot--blink" />
                  )}
                </span>
                <div className="gg-friend-text">
                  <div className="gg-friend-row">
                    <span className="gg-friend-name">{displayName}</span>
                    {unread > 0 && (
                      <span className="gg-friend-unread" title={`${unread} nieprzeczytane`}>
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}
                  </div>
                  {peerDesc && <div className="gg-friend-desc">{peerDesc}</div>}
                </div>
                <button
                  type="button"
                  className="gg-session-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFriend?.(c);
                  }}
                  title="Usuń znajomego"
                  aria-label="Usuń"
                >
                  <span className="gg-glyph gg-glyph--close" />
                </button>
              </div>
            );
          })}
        </Section>
      )}

      <Section
        title={`Historia${activeModel ? ` ${activeModel.name}` : ""}`}
        open={openHistory}
        onToggle={() => setOpenHistory((v) => !v)}
        scroll
        action={
          <button
            type="button"
            className="gg-section-action"
            onClick={(e) => {
              e.stopPropagation();
              onNewSession();
            }}
            title="Nowa rozmowa"
          >
            + Nowy
          </button>
        }
      >
        {modelSessions.length === 0 && (
          <div className="gg-history-empty">Brak rozmów. Napisz wiadomość żeby zacząć.</div>
        )}
        {modelSessions.map((s) => (
          <div
            key={s.id}
            className={`gg-session-item${s.id === activeSessionId && !activePeerUsername ? " is-active" : ""}`}
            onClick={() => onSelectSession(s.id)}
          >
            <span className="gg-session-title">{s.title}</span>
            <span className="gg-session-time">{formatRel(s.updatedAt)}</span>
            <button
              type="button"
              className="gg-session-del"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSession(s.id);
              }}
              title="Usuń rozmowę"
              aria-label="Usuń"
            >
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        ))}
      </Section>

      <div className="gg-sidebar-footer">
        <a className="gg-sidebar-ad" href="#" onClick={(e) => e.preventDefault()}>
          <span className="gg-sidebar-ad-label">Reklama</span>
          <div className="gg-sidebar-ad-row">
            <img className="gg-sidebar-ad-img" src="/larry.webp" alt="Larry" />
            <span className="gg-sidebar-ad-text">A czy ty zjadłeś japuszko? Larry patrzy!</span>
          </div>
        </a>
      </div>
    </aside>
  );
}

interface SectionProps {
  title: string;
  count?: string;
  open: boolean;
  onToggle: () => void;
  scroll?: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

function Section({ title, count, open, onToggle, scroll, action, children }: SectionProps) {
  return (
    <div className={`gg-section${scroll && open ? " gg-section--scroll" : ""}`}>
      <div className="gg-section-header" onClick={onToggle}>
        <span className="gg-section-toggle">{open ? "−" : "+"}</span>
        <span className="gg-section-title">{title}</span>
        {count && <span className="gg-section-count">{count}</span>}
        {open && action}
      </div>
      {open && children && <div className="gg-section-body">{children}</div>}
    </div>
  );
}

function formatRel(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "teraz";
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} godz`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days} dni`;
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

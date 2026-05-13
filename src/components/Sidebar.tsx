import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import sunIcon from "../assets/sun.svg";
import type { SessionMeta, ToolModel } from "../types";
import type { ServerContact, ServerGroup } from "../lib/serverApi";

function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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
  presence?: "online" | "afk" | "push_reachable" | "connecting" | "offline" | "logged_out";
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
  /** Aktualny avatar usera (data URL). Pusty/undefined → fallback na sun.svg. */
  avatar?: string;
  /** Klik w ramkę avatara wywołuje to (rodzic odpala file picker, kompresuje, zapisuje). */
  onChangeAvatar?: () => void;
  /** Mobile drawer: true → sidebar wsunięty, false → schowany za viewport. */
  mobileOpen?: boolean;
  /** Mobile: zamknij drawer (klik w backdrop / wybór elementu z listy). */
  onMobileClose?: () => void;
  // Grupy
  groups?: ServerGroup[];
  activeGroupId?: string | null;
  onSelectGroup?: (id: string) => void;
  onCreateGroup?: () => void;
  unreadByGroup?: Record<string, number>;
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
    avatar,
    onChangeAvatar,
    mobileOpen,
    onMobileClose,
    groups,
    activeGroupId,
    onSelectGroup,
    onCreateGroup,
    unreadByGroup,
  } = props;

  // Wrap onSelectModel/onSelectSession/onSelectPeer żeby na mobilce zamykać
  // drawer po wyborze — typowy mobile UX.
  const closeAfter =
    <Args extends unknown[]>(fn: (...args: Args) => void) =>
    (...args: Args) => {
      fn(...args);
      onMobileClose?.();
    };
  const selectModel = closeAfter(onSelectModel);
  const selectSession = closeAfter(onSelectSession);
  const selectPeer = onSelectPeer ? closeAfter(onSelectPeer) : undefined;

  const [openTools, setOpenTools] = useState(true);
  const [openHistory, setOpenHistory] = useState(true);
  // Mobile-only: w sidebar footer pokazujemy zegar + wersję (statusbar
  // ukryty na mobile). Update co 30s wystarczy — zegar nie musi tickować.
  const [time, setTime] = useState(clock());
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setTime(clock()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);
  const [openFriends, setOpenFriends] = useState(true);
  const [openGroups, setOpenGroups] = useState(true);
  const selectGroup = onSelectGroup ? closeAfter(onSelectGroup) : undefined;

  // (Wcześniej filtrowane per-model; teraz Historia pokazuje wszystkie sesje,
  // każda z badge-em modelu. Usunięte `activeModel` i `modelSessions`.)

  return (
    <>
      {mobileOpen && (
        <div className="gg-sidebar-backdrop" onClick={onMobileClose} aria-hidden />
      )}
      <aside className={`gg-sidebar${mobileOpen ? " is-mobile-open" : ""}`}>
      <div className="gg-profile">
        <div className="gg-profile-avatar">
          <div
            className={`gg-profile-avatar-frame${onChangeAvatar ? " is-clickable" : ""}`}
            onClick={onChangeAvatar}
            role={onChangeAvatar ? "button" : undefined}
            title={onChangeAvatar ? "Zmień avatar" : undefined}
            tabIndex={onChangeAvatar ? 0 : undefined}
          >
            {avatar && avatar.length > 0 ? (
              <img src={avatar} alt="" className="gg-profile-avatar-photo" />
            ) : (
              <img src={sunIcon} alt="" className="gg-profile-avatar-fallback" />
            )}
            {onChangeAvatar && (
              <span className="gg-profile-avatar-edit" aria-hidden>
                ✎
              </span>
            )}
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
                onClick={() => selectPeer?.(c.username)}
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
                          : c.status === "push_reachable"
                            ? "gg-friend-dot--push"
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

      {networkLoggedIn && (
        <Section
          title="Grupy"
          count={groups && groups.length > 0 ? `(${groups.length})` : undefined}
          open={openGroups}
          onToggle={() => setOpenGroups((v) => !v)}
          action={
            onCreateGroup ? (
              <button
                type="button"
                className="gg-section-action"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateGroup();
                }}
                title="Utwórz nową grupę"
              >
                + Nowa
              </button>
            ) : null
          }
        >
          {(!groups || groups.length === 0) && (
            <div className="gg-history-empty">
              Brak grup. Kliknij „+ Nowa" żeby założyć pierwszą.
            </div>
          )}
          {groups?.map((g) => {
            const unread = unreadByGroup?.[g.id] ?? 0;
            return (
              <div
                key={g.id}
                className={`gg-friend-item${activeGroupId === g.id ? " is-active" : ""}`}
                onClick={() => selectGroup?.(g.id)}
                title={`${g.member_count} członków`}
              >
                <span className="gg-friend-dot-wrap" aria-hidden>
                  <span className="gg-friend-dot gg-friend-dot--group" />
                  {unread > 0 && (
                    <span className="gg-friend-dot gg-friend-dot--unread gg-friend-dot--blink" />
                  )}
                </span>
                <div className="gg-friend-text">
                  <div className="gg-friend-row">
                    <span className="gg-friend-name">{g.name}</span>
                    {unread > 0 && (
                      <span className="gg-friend-unread" title={`${unread} nieprzeczytanych`}>
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}
                  </div>
                  <div className="gg-friend-desc">{g.member_count} osób</div>
                </div>
              </div>
            );
          })}
        </Section>
      )}

      <Section
        title="Narzędzia (CLI)"
        open={openTools}
        onToggle={() => setOpenTools((v) => !v)}
      >
        {/* Pojedyncza pozycja "AI Chat" zamiast listy per-model. Wybór modelu
           dla nowej rozmowy przez dropdown przy "+ Nowy" w sekcji Historia. */}
        <div
          className={`gg-tool-item${!activePeerUsername && !activeGroupId ? " is-active" : ""}`}
          onClick={() => selectModel(activeModelId)}
        >
          <span
            className="gg-tool-item-status gg-tool-item-status--on"
            aria-hidden
          />
          <span className="gg-tool-item-name">AI Chat</span>
        </div>
      </Section>

      {!activePeerUsername && !activeGroupId && (
      <Section
        title="Historia"
        open={openHistory}
        onToggle={() => setOpenHistory((v) => !v)}
        scroll
        action={
          <NewSessionMenu
            models={models}
            configuredByModel={configuredByModel}
            onPick={(modelId) => {
              onSelectModel(modelId);
              onNewSession();
            }}
          />
        }
      >
        {sessions.length === 0 && (
          <div className="gg-history-empty">Brak rozmów. Napisz wiadomość żeby zacząć.</div>
        )}
        {sessions.map((s) => {
          const modelName = models.find((m) => m.id === s.modelId)?.name ?? s.modelId;
          return (
          <div
            key={s.id}
            className={`gg-session-item${s.id === activeSessionId && !activePeerUsername && !activeGroupId ? " is-active" : ""}`}
            onClick={() => selectSession(s.id)}
          >
            <span className="gg-session-title">{s.title}</span>
            <span className="gg-session-model-badge" title={modelName}>{modelName}</span>
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
          );
        })}
      </Section>
      )}

      <div className="gg-sidebar-footer">
        <a className="gg-sidebar-ad" href="#" onClick={(e) => e.preventDefault()}>
          <span className="gg-sidebar-ad-label">Reklama</span>
          <div className="gg-sidebar-ad-row">
            <img className="gg-sidebar-ad-img" src="/larry.webp" alt="Larry" />
            <span className="gg-sidebar-ad-text">A czy ty zjadłeś japuszko? Larry patrzy!</span>
          </div>
        </a>
        <div className="gg-sidebar-mobile-status" aria-hidden>
          <span>{time}</span>
          {version && <span>v{version}</span>}
        </div>
      </div>
      </aside>
    </>
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

function NewSessionMenu({
  models,
  configuredByModel,
  onPick,
}: {
  models: ToolModel[];
  configuredByModel: Record<string, boolean>;
  onPick: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="gg-newsession" ref={ref}>
      <button
        type="button"
        className="gg-section-action"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Nowa rozmowa"
      >
        + Nowy
      </button>
      {open && (
        <div className="gg-newsession-menu" onClick={(e) => e.stopPropagation()}>
          {models.map((m) => {
            const ok = configuredByModel[m.id] === true;
            return (
              <button
                key={m.id}
                type="button"
                className="gg-newsession-item"
                onClick={() => {
                  setOpen(false);
                  onPick(m.id);
                }}
                disabled={!ok}
                title={ok ? m.name : `${m.name} — wymaga konfiguracji`}
              >
                <span>{m.name}</span>
                {!ok && <span className="gg-newsession-item-meta">brak konfiguracji</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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

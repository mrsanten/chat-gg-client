import { useState } from "react";
import sunIcon from "../assets/sun.svg";
import type { SessionMeta, ToolModel } from "../types";

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
  onEditProfile?: () => void;
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
    onEditProfile,
  } = props;

  const [openTools, setOpenTools] = useState(true);
  const [openHistory, setOpenHistory] = useState(true);
  const [desc, setDesc] = useState("");

  const activeModel = models.find((m) => m.id === activeModelId);
  const modelSessions = sessions.filter((s) => s.modelId === activeModelId);

  return (
    <aside className="gg-sidebar">
      <div className="gg-profile">
        <div className="gg-profile-avatar">
          <div className="gg-profile-avatar-frame">
            <img src={sunIcon} alt="" />
          </div>
          <div className="gg-profile-avatar-bar" aria-hidden />
        </div>
        <div className="gg-profile-info">
          <div
            className="gg-profile-name"
            onClick={onEditProfile}
            title={onEditProfile ? "Edytuj profil" : undefined}
            role={onEditProfile ? "button" : undefined}
          >
            {nick && nick.trim().length > 0 ? nick : "Użytkownik"}
          </div>
          <div className="gg-profile-status">Dostępny</div>
          <input
            className="gg-profile-desc"
            placeholder="Wpisz opis..."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
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
              className={`gg-tool-item${m.id === activeModelId ? " is-active" : ""}`}
              onClick={() => onSelectModel(m.id)}
            >
              <img src={sunIcon} alt="" className="gg-tool-item-icon" />
              <span className="gg-tool-item-name">{m.name}</span>
              <span
                className={`gg-tool-item-status ${ok ? "gg-tool-item-status--on" : "gg-tool-item-status--off"}`}
                title={ok ? "Skonfigurowane" : "Brak konfiguracji - otwórz Ustawienia"}
              />
            </div>
          );
        })}
      </Section>

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
            className={`gg-session-item${s.id === activeSessionId ? " is-active" : ""}`}
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

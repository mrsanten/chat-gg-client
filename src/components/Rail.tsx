import { useEffect, useRef, useState } from "react";
import appIcon from "../assets/app-icon.png";

/** Widoki dostępne z railu. */
export type RailView = "messenger" | "ai" | "notes" | "pomodoro";

interface Props {
  onOpenSettings: () => void;
  onOpenMacros: () => void;
  onOpenNetwork: () => void;
  onOpenChangelog: () => void;
  onCheckForUpdates: () => void;
  /** Tylko widoczne gdy `loggedInUsername` jest niepusty. */
  onLogout?: () => void;
  loggedInUsername?: string | null;
  onQuit: () => void;
  /** Czy WebSocket jest aktywny — kropka na ikonie sieci. */
  networkOnline?: boolean;
  /** Aktywny widok railu. */
  view: RailView;
  onSelectView: (view: RailView) => void;
  /** Mobile: otwórz/zamknij drawer sidebaru. CSS chowa hamburger na desktopie. */
  onToggleSidebar?: () => void;
}

/** Wspólne propsy SVG — spójna, nowoczesna kreska (line-style). */
const SVG = {
  className: "gg-rail-ico",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const IconMenu = () => (
  <svg {...SVG}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);

const IconMacros = () => (
  <svg {...SVG}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M18 14.5l.8 2.1 2.2.9-2.2.9-.8 2.1-.8-2.1-2.2-.9 2.2-.9z" />
  </svg>
);

const IconNetwork = () => (
  <svg {...SVG}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
  </svg>
);

const IconSettings = () => (
  <svg {...SVG}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconMessenger = () => (
  <svg {...SVG}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
    <path d="M8 12h.01M12 12h.01M16 12h.01" />
  </svg>
);

const IconAI = () => (
  <svg {...SVG}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M19.07 4.93l-2.12 2.12M7.05 16.95l-2.12 2.12M22 12h-3M5 12H2M19.07 19.07l-2.12-2.12M7.05 7.05 4.93 4.93" />
  </svg>
);

const IconNotes = () => (
  <svg {...SVG}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
    <path d="M8 13h8M8 17h6" />
  </svg>
);

const IconTimer = () => (
  <svg {...SVG}>
    <path d="M10 2h4" />
    <circle cx="12" cy="14" r="8" />
    <path d="M12 10v4l2.5 2.5" />
  </svg>
);

const IconMore = () => (
  <svg {...SVG} fill="currentColor" stroke="none">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
);

/**
 * Pionowy pasek akcji (rail) w stylu Discord/Slack. Na mobile reflow do
 * poziomego paska u góry (CSS). Skupia globalne akcje wcześniej rozsiane po
 * pasku menu i toolbarze: Makra, Sieć, Ustawienia + menu (aktualizacje,
 * changelog, wylogowanie, zamknięcie).
 */
export function Rail({
  onOpenSettings,
  onOpenMacros,
  onOpenNetwork,
  onOpenChangelog,
  onCheckForUpdates,
  onLogout,
  loggedInUsername,
  onQuit,
  networkOnline,
  view,
  onSelectView,
  onToggleSidebar,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <nav className="gg-rail" aria-label="Pasek akcji">
      {onToggleSidebar && (
        <button
          type="button"
          className="gg-rail-btn gg-rail-hamburger"
          onClick={onToggleSidebar}
          aria-label="Otwórz menu boczne"
        >
          <IconMenu />
        </button>
      )}
      <div className="gg-rail-logo" aria-hidden>
        <img src={appIcon} alt="" />
      </div>

      <div className="gg-rail-nav">
        <button
          type="button"
          className={`gg-rail-btn gg-rail-navbtn${view === "messenger" ? " is-active" : ""}`}
          onClick={() => onSelectView("messenger")}
          title="Komunikator — znajomi i grupy"
          aria-label="Komunikator"
        >
          <IconMessenger />
        </button>
        <button
          type="button"
          className={`gg-rail-btn gg-rail-navbtn${view === "ai" ? " is-active" : ""}`}
          onClick={() => onSelectView("ai")}
          title="Czat AI"
          aria-label="Czat AI"
        >
          <IconAI />
        </button>
        <button
          type="button"
          className={`gg-rail-btn gg-rail-navbtn${view === "notes" ? " is-active" : ""}`}
          onClick={() => onSelectView("notes")}
          title="Notatki"
          aria-label="Notatki"
        >
          <IconNotes />
        </button>
        <button
          type="button"
          className={`gg-rail-btn gg-rail-navbtn${view === "pomodoro" ? " is-active" : ""}`}
          onClick={() => onSelectView("pomodoro")}
          title="Pomodoro"
          aria-label="Pomodoro"
        >
          <IconTimer />
        </button>
      </div>

      <div className="gg-rail-spacer" />

      <button
        type="button"
        className="gg-rail-btn"
        onClick={onOpenMacros}
        title="Makra"
        aria-label="Makra"
      >
        <IconMacros />
      </button>
      <button
        type="button"
        className={`gg-rail-btn${networkOnline ? " is-online" : ""}`}
        onClick={onOpenNetwork}
        title="Sieć Gaidu"
        aria-label="Sieć Gaidu"
      >
        <IconNetwork />
        <span
          className={`gg-rail-dot${networkOnline ? " is-online" : ""}`}
          aria-hidden
        />
      </button>
      <button
        type="button"
        className="gg-rail-btn"
        onClick={onOpenSettings}
        title="Ustawienia"
        aria-label="Ustawienia"
      >
        <IconSettings />
      </button>

      <div className="gg-rail-menu" ref={menuRef}>
        <button
          type="button"
          className={`gg-rail-btn${menuOpen ? " is-active" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          title="Więcej"
          aria-label="Więcej"
        >
          <IconMore />
        </button>
        {menuOpen && (
          <div
            className="gg-menu-dropdown gg-rail-dropdown"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="gg-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onCheckForUpdates();
              }}
            >
              Sprawdź aktualizacje
            </button>
            <button
              type="button"
              className="gg-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onOpenChangelog();
              }}
            >
              Changelog
            </button>
            {loggedInUsername && onLogout && (
              <>
                <div className="gg-menu-sep" />
                <button
                  type="button"
                  className="gg-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                  title={`Zalogowany jako ${loggedInUsername}`}
                >
                  Wyloguj ({loggedInUsername})
                </button>
              </>
            )}
            <div className="gg-menu-sep" />
            <button
              type="button"
              className="gg-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onQuit();
              }}
            >
              Zamknij
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}

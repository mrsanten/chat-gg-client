import { useEffect, useRef, useState } from "react";
import appIcon from "../assets/app-icon.png";

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
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 14.5 1.7 1.7 0 0 0 3.03 13.5H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87V8.5a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
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

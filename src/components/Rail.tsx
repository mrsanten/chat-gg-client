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
          <span className="gg-rail-ico">☰</span>
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
        <span className="gg-rail-ico">✦</span>
      </button>
      <button
        type="button"
        className={`gg-rail-btn${networkOnline ? " is-online" : ""}`}
        onClick={onOpenNetwork}
        title="Sieć Gaidu"
        aria-label="Sieć Gaidu"
      >
        <span className="gg-rail-ico">🌐</span>
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
        <span className="gg-rail-ico">⚙</span>
      </button>

      <div className="gg-rail-menu" ref={menuRef}>
        <button
          type="button"
          className={`gg-rail-btn${menuOpen ? " is-active" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          title="Więcej"
          aria-label="Więcej"
        >
          <span className="gg-rail-ico">⋯</span>
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

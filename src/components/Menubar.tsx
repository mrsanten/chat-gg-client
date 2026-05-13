import { useEffect, useRef, useState } from "react";

interface Props {
  onOpenSettings: () => void;
  onOpenChangelog: () => void;
  onCheckForUpdates: () => void;
  /** Tylko widoczne gdy `loggedInUsername` jest niepusty. */
  onLogout?: () => void;
  loggedInUsername?: string | null;
  onQuit: () => void;
}

export function Menubar({
  onOpenSettings,
  onOpenChangelog,
  onCheckForUpdates,
  onLogout,
  loggedInUsername,
  onQuit,
}: Props) {
  const [openMenu, setOpenMenu] = useState<null | "main" | "help">(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  return (
    <div className="gg-menubar" ref={ref}>
      <div
        className={`gg-menubar-item${openMenu === "main" ? " is-open" : ""}`}
        onClick={() => setOpenMenu((v) => (v === "main" ? null : "main"))}
      >
        <span>
          <u>G</u>aidu
        </span>
        {openMenu === "main" && (
          <div className="gg-menu-dropdown" onMouseDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="gg-menu-item"
              onClick={() => {
                setOpenMenu(null);
                onOpenSettings();
              }}
            >
              Ustawienia
            </button>
            <button
              type="button"
              className="gg-menu-item"
              onClick={() => {
                setOpenMenu(null);
                onCheckForUpdates();
              }}
            >
              Sprawdź aktualizacje
            </button>
            {loggedInUsername && onLogout && (
              <>
                <div className="gg-menu-sep" />
                <button
                  type="button"
                  className="gg-menu-item"
                  onClick={() => {
                    setOpenMenu(null);
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
                setOpenMenu(null);
                onQuit();
              }}
            >
              Zamknij
            </button>
          </div>
        )}
      </div>

      <div
        className="gg-menubar-item"
        onClick={() => {
          setOpenMenu(null);
          onOpenChangelog();
        }}
      >
        <span>
          <u>C</u>hangelog
        </span>
      </div>

      <div className="gg-menubar-item">
        <span>
          <u>P</u>omoc
        </span>
      </div>
    </div>
  );
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import sunIcon from "../assets/sun.svg";

export function Titlebar({ title }: { title: string }) {
  const win = getCurrentWindow();

  return (
    <div className="gg-titlebar" data-tauri-drag-region>
      <img src={sunIcon} alt="" className="gg-titlebar-icon" data-tauri-drag-region />
      <span className="gg-titlebar-text" data-tauri-drag-region>{title}</span>
      <div className="gg-titlebar-buttons">
        <button
          className="gg-titlebar-btn"
          aria-label="Minimalizuj"
          onClick={() => win.minimize()}
        >
          <span className="gg-glyph gg-glyph--min" />
        </button>
        <button
          className="gg-titlebar-btn"
          aria-label="Maksymalizuj"
          onClick={() => win.toggleMaximize()}
        >
          <span className="gg-glyph gg-glyph--max" />
        </button>
        <button
          className="gg-titlebar-btn gg-titlebar-btn--close"
          aria-label="Zamknij"
          onClick={() => win.close()}
        >
          <span className="gg-glyph gg-glyph--close" />
        </button>
      </div>
    </div>
  );
}

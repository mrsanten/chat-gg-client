import sunIcon from "../assets/sun.svg";
import { CHANGELOG } from "../data/changelog";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ChangelogDialog({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal gg-modal--wide">
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Changelog</span>
          <div className="gg-chatwin-titlebar-buttons">
            <button className="gg-chatwin-titlebar-btn" onClick={onClose} aria-label="Zamknij">
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>
        <div className="gg-modal-body">
          {CHANGELOG.map((entry) => (
            <section key={entry.version} className="gg-changelog-entry">
              <header className="gg-changelog-head">
                <span className="gg-changelog-version">v{entry.version}</span>
                <span className="gg-changelog-date">{entry.date}</span>
              </header>
              <ul className="gg-changelog-list">
                {entry.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="gg-modal-actions">
          <button type="button" className="gg-btn" onClick={onClose}>
            Zamknij
          </button>
        </div>
      </div>
    </div>
  );
}

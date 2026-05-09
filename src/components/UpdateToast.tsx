import sunIcon from "../assets/sun.svg";
import type { DownloadStatus, PendingUpdate } from "../lib/updater";

interface Props {
  pending: PendingUpdate;
  status: DownloadStatus;
  onInstall: () => void;
  onDismiss: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateToast({ pending, status, onInstall, onDismiss }: Props) {
  const downloading = status.state === "downloading";
  const installing = status.state === "installing";
  const errored = status.state === "error";
  const busy = downloading || installing;

  const progressPct =
    status.state === "downloading" && status.total && status.total > 0
      ? Math.min(100, Math.round((status.downloaded / status.total) * 100))
      : null;

  return (
    <div className="gg-update-toast" role="status" aria-live="polite">
      <div className="gg-update-toast-header">
        <img src={sunIcon} alt="" className="gg-update-toast-icon" />
        <span className="gg-update-toast-title">Nowa wersja GAIdu GAIdu</span>
        {!busy && (
          <button
            type="button"
            className="gg-chatwin-titlebar-btn gg-update-toast-close"
            onClick={onDismiss}
            aria-label="Zamknij powiadomienie"
            title="Zamknij"
          >
            <span className="gg-glyph gg-glyph--close" />
          </button>
        )}
      </div>

      <div className="gg-update-toast-body">
        <div className="gg-update-toast-version">
          <span className="gg-update-toast-version-old">{pending.currentVersion}</span>
          <span className="gg-update-toast-arrow" aria-hidden>
            →
          </span>
          <span className="gg-update-toast-version-new">{pending.version}</span>
        </div>

        {pending.notes && (
          <div className="gg-update-toast-notes" title={pending.notes}>
            {pending.notes.length > 200 ? pending.notes.slice(0, 200) + "…" : pending.notes}
          </div>
        )}

        {downloading && (
          <div className="gg-update-toast-progress">
            <div className="gg-update-toast-progress-bar">
              <div
                className="gg-update-toast-progress-fill"
                style={{ width: progressPct != null ? `${progressPct}%` : "30%" }}
              />
            </div>
            <span className="gg-update-toast-progress-label">
              {progressPct != null
                ? `${progressPct}% (${formatBytes(status.downloaded)} / ${formatBytes(status.total ?? 0)})`
                : `Pobieranie: ${formatBytes(status.downloaded)}`}
            </span>
          </div>
        )}

        {installing && <div className="gg-update-toast-installing">Instaluję…</div>}

        {errored && (
          <div className="gg-update-toast-error">Błąd: {status.message}</div>
        )}
      </div>

      <div className="gg-update-toast-actions">
        <button
          type="button"
          className="gg-btn"
          onClick={onDismiss}
          disabled={busy}
        >
          Później
        </button>
        <button
          type="button"
          className="gg-send-btn"
          onClick={onInstall}
          disabled={busy}
        >
          <span>{busy ? "..." : "Aktualizuj i zrestartuj"}</span>
        </button>
      </div>
    </div>
  );
}

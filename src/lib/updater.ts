import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface PendingUpdate {
  /** Surowy obiekt z pluginu — trzymamy, żeby później wywołać download/install. */
  update: Update;
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}

export type DownloadStatus =
  | { state: "idle" }
  | { state: "downloading"; downloaded: number; total?: number }
  | { state: "installing" }
  | { state: "error"; message: string };

/**
 * Sprawdza endpoint updatera. Zwraca info o nowej wersji albo `null`,
 * gdy aplikacja jest aktualna lub coś poszło nie tak (błąd jest cicho
 * połykany — popup się po prostu nie pojawi).
 */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      update,
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? undefined,
      date: update.date ?? undefined,
    };
  } catch (err) {
    console.warn("[updater] check failed", err);
    return null;
  }
}

/**
 * Pobiera + instaluje wcześniej znalezioną aktualizację, na końcu restartuje
 * aplikację. Zwraca `false` jeśli wystąpił błąd (status z opisem trafia do
 * `onStatus`).
 */
export async function installUpdate(
  pending: PendingUpdate,
  onStatus: (status: DownloadStatus) => void = () => {},
): Promise<boolean> {
  try {
    let downloaded = 0;
    let total: number | undefined;
    onStatus({ state: "downloading", downloaded: 0, total });

    await pending.update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength;
          onStatus({ state: "downloading", downloaded: 0, total });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onStatus({ state: "downloading", downloaded, total });
          break;
        case "Finished":
          onStatus({ state: "installing" });
          break;
      }
    });

    await relaunch();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onStatus({ state: "error", message });
    return false;
  }
}

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; notes?: string; date?: string }
  | { state: "downloading"; downloaded: number; total?: number }
  | { state: "ready" }
  | { state: "up-to-date" }
  | { state: "error"; message: string };

export type UpdaterListener = (status: UpdaterStatus) => void;

/**
 * Check for an update and, if available, download + install it.
 * `silent`: when true, returns early without throwing if no update is found.
 *
 * Wymaga skonfigurowanego `plugins.updater` w tauri.conf.json oraz publikacji
 * podpisanego artefaktu + manifestu `latest.json` pod adresem `endpoints`.
 */
export async function runUpdateFlow(onStatus: UpdaterListener = () => {}): Promise<void> {
  try {
    onStatus({ state: "checking" });
    const update: Update | null = await check();

    if (!update) {
      onStatus({ state: "up-to-date" });
      return;
    }

    onStatus({
      state: "available",
      version: update.version,
      notes: update.body ?? undefined,
      date: update.date ?? undefined,
    });

    let downloaded = 0;
    let total: number | undefined;

    await update.downloadAndInstall((event) => {
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
          onStatus({ state: "ready" });
          break;
      }
    });

    // Na Windows/Linux trzeba sami zrestartować, na macOS Tauri robi to samo
    // po zakończeniu installu. `relaunch()` jest bezpieczne na obu.
    await relaunch();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onStatus({ state: "error", message });
  }
}

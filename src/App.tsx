import { useEffect, useMemo, useRef, useState } from "react";
import { Titlebar } from "./components/Titlebar";
import { Rail } from "./components/Rail";
import { Menubar } from "./components/Menubar";
import { Toolbar } from "./components/Toolbar";
import { Statusbar } from "./components/Statusbar";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { SettingsDialog } from "./components/Settings";
import { MacrosDialog } from "./components/MacrosDialog";
import { UpdateToast } from "./components/UpdateToast";
import { ChangelogDialog } from "./components/ChangelogDialog";
import { NetworkAccountDialog } from "./components/NetworkAccountDialog";
import { AddFriendDialog } from "./components/AddFriendDialog";
import { UserProfileDialog } from "./components/UserProfileDialog";
import { CreateGroupDialog } from "./components/CreateGroupDialog";
import { GroupProfileDialog } from "./components/GroupProfileDialog";
import { useMobile } from "./lib/useMobile";
import { invoke } from "@tauri-apps/api/core";
import * as serverApi from "./lib/serverApi";
import type { ServerContact, HistoryEntry } from "./lib/serverApi";
import {
  NetworkClient,
  type ConnectionStatus,
  type NetworkStats,
  type ServerEvent as NetEvent,
} from "./lib/network";
// Legacy MLS handlery dla wstecznej kompatybilności — userzy ze starszych
// wersji wciąż mogą wysyłać blob/welcome, my je rozumiemy ale od v0.10.0
// sami wysyłamy plain WS message.
import { mlsProcessWelcome, mlsDecrypt } from "./lib/mls";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MODELS } from "./data/models";
import { checkConfigured, streamChat, welcomeText, ProviderError } from "./lib/providers";
import { augmentForApi } from "./lib/macros";
import { playNotify } from "./lib/sound";
import { loadSettings } from "./lib/settings";
import {
  checkForUpdate,
  installUpdate,
  type DownloadStatus,
  type PendingUpdate,
} from "./lib/updater";
import {
  clearSessionCache,
  deleteSession as deleteSessionRpc,
  deriveTitle,
  listSessions,
  loadSession as loadSessionRpc,
  saveSession as saveSessionRpc,
} from "./lib/sessions";
import {
  DEFAULT_SETTINGS,
  type ChatMessage,
  type ChatSession,
  type ImageAttachment,
  type SessionMeta,
  type Settings,
  type ToolModel,
} from "./types";

function fmtTime(d: Date) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function welcomeMessage(model: ToolModel, settings: Settings): ChatMessage {
  return {
    id: "welcome-" + model.id,
    role: "assistant",
    modelId: model.id,
    text: welcomeText(model, settings),
    timestamp: fmtTime(new Date()),
  };
}

function sessionToMessages(session: ChatSession): ChatMessage[] {
  return session.messages.map((m) => ({
    id: m.id,
    role: m.role,
    modelId: session.modelId,
    text: m.text,
    timestamp: m.timestamp,
    errored: m.errored,
    images: m.images,
  }));
}

function messagesToStored(messages: ChatMessage[]): ChatSession["messages"] {
  return messages
    .filter((m) => !m.id.startsWith("welcome-"))
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      errored: m.errored,
      images: m.images,
    }));
}

const PENDING_SESSION_KEY = "__pending__";

export default function App() {
  const isMobile = useMobile();
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  // Widok railu: komunikator (znajomi/grupy) vs AI. Steruje sekcjami sidebara.
  const [railView, setRailView] = useState<"messenger" | "ai">("ai");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  /**
   * Stan boot-a sieci. Ustawiamy w useEffect po sprawdzeniu tokena.
   * - loading            — w trakcie sprawdzania
   * - needs_login        — token brak / nieważny, wymagaj logowania
   * - logged_in          — token OK, jesteśmy w sieci
   * - server_unreachable — server padł, ale token jest; tryb degradowany
   *                        (apka działa, ale tylko AI chats, peer disabled)
   */
  const [netBootState, setNetBootState] = useState<
    "loading" | "needs_login" | "logged_in" | "server_unreachable"
  >("loading");
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [contacts, setContacts] = useState<ServerContact[]>([]);
  const [groups, setGroups] = useState<serverApi.ServerGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupMessagesByGroup, setGroupMessagesByGroup] = useState<
    Record<string, PeerMessage[]>
  >({});
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>({});
  const activeGroupIdRef = useRef<string | null>(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupProfileOpen, setGroupProfileOpen] = useState(false);
  const [myDescription, setMyDescription] = useState<string>("");
  const [myAvatar, setMyAvatar] = useState<string>("");
  const [myJoinedAt, setMyJoinedAt] = useState<string>("");
  /** Modal profilu: "self" → mój profil; "peer" → peer po username; null → zamknięty. */
  const [profileDialog, setProfileDialog] = useState<
    | { mode: "self" }
    | { mode: "peer"; username: string }
    | null
  >(null);
  const descSaveTimerRef = useRef<number | null>(null);
  /** Status presence który CLIENT sam sobie ustawia (online/afk). Server
   *  trzyma to w pamięci hub-a, my synchronizujemy idle-detectorem. */
  const [myStatus, setMyStatus] = useState<"online" | "afk">("online");
  const [activePeerUsername, setActivePeerUsername] = useState<string | null>(null);
  const [peerMessagesByPeer, setPeerMessagesByPeer] = useState<Record<string, PeerMessage[]>>({});
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({ kind: "idle" });
  const [netStats, setNetStats] = useState<NetworkStats | null>(null);
  const [typingByPeer, setTypingByPeer] = useState<Record<string, boolean>>({});
  const typingTimersRef = useRef<Map<string, number>>(new Map());
  /** Per-grupa: zbiór username-ów aktualnie piszących (oprócz mnie). */
  const [typingByGroup, setTypingByGroup] = useState<Record<string, Set<string>>>(
    {},
  );
  const groupTypingTimersRef = useRef<Map<string, number>>(new Map());
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const activePeerUsernameRef = useRef<string | null>(null);
  /** Timestamp ostatniego WS "ready" event (reconnect). Używane do tłumienia
   *  playNotify() dla wiadomości flush-owanych z offline queue — te i tak
   *  zagrały już dźwięk na native APNs banner gdy user był offline. */
  const lastReadyAtRef = useRef<number>(0);
  const networkRef = useRef<NetworkClient | null>(null);
  const historyLoadedFor = useRef<Set<string>>(new Set());
  // Phase 3D: mapping peer_username → group_id_b64. Populowany przy
  // boot z mls_list_groups + przy każdym welcome/create.
  const peerGroupRef = useRef<Map<string, string>>(new Map());
  // Odwrotny mapping group_id_b64 → peer_username (dla blob lookup).
  const groupPeerRef = useRef<Map<string, string>>(new Map());
  const [sessionMacrosBySession, setSessionMacrosBySession] = useState<
    Record<string, string[]>
  >({});
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DownloadStatus>({ state: "idle" });
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const dismissedVersionRef = useRef<string | null>(null);
  const pendingUpdateRef = useRef<PendingUpdate | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const [activeModelId, setActiveModelId] = useState<string>(MODELS[0].id);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionByModel, setActiveSessionByModel] = useState<Record<string, string | null>>(
    {},
  );
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const activeModel = useMemo(
    () => MODELS.find((m) => m.id === activeModelId) ?? MODELS[0],
    [activeModelId],
  );

  const configuredByModel = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const m of MODELS) {
      out[m.id] = checkConfigured(m, settings) === null;
    }
    return out;
  }, [settings]);

  const activeSessionId = activeSessionByModel[activeModelId] ?? null;
  const activeSessionMeta = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId) ?? null
    : null;

  const messages: ChatMessage[] = activeSessionId
    ? messagesBySession[activeSessionId] ?? []
    : [welcomeMessage(activeModel, settings)];

  useEffect(() => {
    (async () => {
      // listSessions() bez tokenu zwraca lokalne sesje (Tauri local file —
      // przeżywa update apki). tryRestore później dorzuci server-side sync.
      const s = await loadSettings();
      setSettings(s);
      void listSessions().then(setSessions);
      // Walidacja JWT przy starcie. Jeśli nieważny → wyczyść z settings,
      // żeby przy następnym otwarciu NetworkAccountDialog user widział
      // formularz logowania zamiast „już zalogowany".
      if (s.network?.token && s.network.server_url) {
        const tryRestore = async (currentSettings: typeof s, accountId: string) => {
          void refreshContacts(currentSettings.network.server_url, currentSettings.network.token);
          void refreshGroups(currentSettings.network.server_url, currentSettings.network.token);
          void refreshSessions(currentSettings.network.server_url, currentSettings.network.token);
          void refreshSecrets(currentSettings.network.server_url, currentSettings.network.token);
          try {
            const raw = localStorage.getItem(`peer-msgs:${accountId}`);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                setPeerMessagesByPeer(parsed);
              }
            }
          } catch (e) {
            console.warn("[storage] peer-msgs load:", e);
          }
        };

        try {
          const me = await serverApi.me(s.network.server_url, s.network.token);
          setMyDescription(me.description ?? "");
          setMyAvatar(me.avatar ?? "");
          setMyJoinedAt(me.created_at ?? "");
          await tryRestore(s, me.id);
          setNetBootState("logged_in");
        } catch (e) {
          if (e instanceof serverApi.ServerError && e.status === 401) {
            const username = s.network.username;
            const password = s.network.password;
            if (username && password) {
              try {
                console.info("[network] auto-relogin via username+password");
                const auth = await serverApi.login(s.network.server_url, username, password);
                const refreshed = {
                  ...s,
                  network: {
                    ...s.network,
                    token: auth.token,
                    account_id: auth.account.id,
                    username: auth.account.username,
                  },
                };
                const settingsLib = await import("./lib/settings");
                await settingsLib.saveSettings(refreshed);
                setSettings(refreshed);
                setMyDescription(auth.account.description ?? "");
                setMyAvatar(auth.account.avatar ?? "");
                setMyJoinedAt(auth.account.created_at ?? "");
                await tryRestore(refreshed, auth.account.id);
                setNetBootState("logged_in");
              } catch (loginErr) {
                if (loginErr instanceof serverApi.ServerError && loginErr.status === 401) {
                  console.warn("[network] auto-relogin: złe credentials, czyszczę");
                  const cleared = {
                    ...s,
                    network: {
                      ...s.network,
                      token: "",
                      account_id: null,
                      username: null,
                      password: null,
                    },
                  };
                  const settingsLib = await import("./lib/settings");
                  await settingsLib.saveSettings(cleared);
                  setSettings(cleared);
                  setNetBootState("needs_login");
                } else {
                  // Network error przy auto-relogin → server down.
                  console.info("[network] auto-relogin: server unreachable, tryb degradowany");
                  setNetBootState("server_unreachable");
                }
              }
            } else {
              const cleared = {
                ...s,
                network: { ...s.network, token: "", account_id: null, username: null },
              };
              const settingsLib = await import("./lib/settings");
              await settingsLib.saveSettings(cleared);
              setSettings(cleared);
              setNetBootState("needs_login");
            }
          } else {
            // Serwer down — degraded mode.
            console.info("[network] /me failed (server down?):", e);
            setNetBootState("server_unreachable");
          }
        }
      } else {
        setNetBootState("needs_login");
      }
    })();
    // Sprawdź aktualizacje w tle przy starcie + co 5 minut + przy powrocie
    // do okna. Jeśli nowa wersja istnieje, wystawimy popup w prawym górnym
    // rogu (chyba że user już go odrzucił dla tej samej wersji).
    const tryCheck = async () => {
      const pending = await checkForUpdate();
      if (!pending) return;
      // Nie odświeżamy aktywnego toasta tym samym buildem.
      if (
        pendingUpdateRef.current &&
        pendingUpdateRef.current.version === pending.version
      ) {
        return;
      }
      // Nie wracaj z tym samym numerkiem, jeśli user kliknął „Później".
      if (dismissedVersionRef.current === pending.version) return;
      setPendingUpdate(pending);
    };
    void tryCheck();
    const interval = window.setInterval(tryCheck, 5 * 60 * 1000);
    const onFocus = () => {
      void tryCheck();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
      if (descSaveTimerRef.current != null) window.clearTimeout(descSaveTimerRef.current);
      // Wyczyść typing-timery przy unmount.
      for (const t of typingTimersRef.current.values()) window.clearTimeout(t);
      typingTimersRef.current.clear();
      abortRef.current?.abort();
    };
  }, []);

  // OS: data-os="mac"/"win"/"other" na <html>. CSS używa tego do natywnych
  // przycisków okna (traffic lights na macOS, płaskie kontrolki na Windows).
  useEffect(() => {
    const ua = navigator.userAgent;
    document.documentElement.dataset.os = /Mac/i.test(ua)
      ? "mac"
      : /Win/i.test(ua)
        ? "win"
        : "other";
  }, []);

  // Blokada natywnego menu kontekstowego (prawy przycisk myszy). Wiadomości
  // mają własną obsługę prawego przycisku (kopiowanie) na poziomie komponentu.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  // Theme: ustawiamy data-theme="default"/"default-dark"/"light" na <html>.
  // CSS używa [data-theme^="default"] / [data-theme="..."] do kolorów.
  // "system" śledzi preferencję OS i przełącza nowy jasny/ciemny. Stary XP
  // "dark" został usunięty — stara wartość mapuje się na "default-dark".
  useEffect(() => {
    const choice = settings.theme ?? "default";
    const apply = () => {
      let resolved: "default" | "default-dark" | "light";
      if (choice === "system") {
        resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "default-dark"
          : "default";
      } else if ((choice as string) === "dark") {
        resolved = "default-dark";
      } else {
        resolved = choice;
      }
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    if (choice === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => apply();
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
  }, [settings.theme]);

  // Trzymaj refy w sync z aktualnym state'em, żeby callback z setIntervala
  // używał świeżych wartości bez wymuszania re-rejestracji.
  useEffect(() => {
    pendingUpdateRef.current = pendingUpdate;
  }, [pendingUpdate]);

  useEffect(() => {
    activePeerUsernameRef.current = activePeerUsername;
  }, [activePeerUsername]);

  useEffect(() => {
    activeGroupIdRef.current = activeGroupId;
  }, [activeGroupId]);

  // Jeśli zostałem usunięty z grupy / grupa skasowana — `groups` z servera
  // już jej nie zawiera, a `activeGroupId` wciąż wskazuje. Zamknij chat.
  useEffect(() => {
    if (activeGroupId && !groups.some((g) => g.id === activeGroupId)) {
      setActiveGroupId(null);
    }
  }, [groups, activeGroupId]);

  // Push notifications: native iOS code (main.mm::ApnsBootstrap) prosi
  // o permission i zapisuje token do `<Caches>/apns_token.txt`. Polluje-my
  // ten plik przez 60s po login-ie, POST-ujemy na server jak token się
  // pojawi. Idempotentny (upsert na server-side), więc próby bez tokena
  // i ponowne rejestracje są OK.
  useEffect(() => {
    const jwt = settings.network?.token;
    const serverUrl = settings.network?.server_url;
    if (!jwt || !serverUrl) return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // 12 × 5s = 60s
    const tryRegister = async () => {
      if (cancelled) return;
      attempts++;
      try {
        const deviceToken = await invoke<string | null>("get_apns_token");
        if (deviceToken && !cancelled) {
          await serverApi.registerDevice(serverUrl, jwt, {
            token: deviceToken,
            platform: "ios",
            app_bundle_id: "com.mrellwart.gaidugaidu",
            // Musi pasować do APNS_ENVIRONMENT na serwerze + aps-environment
            // w entitlements. `development` dla `pnpm tauri ios dev`,
            // `production` dla TestFlight/App Store buildów.
            apns_env: "production",
          });
          console.info("[push] device token registered on server");
          return; // success, stop polling
        }
      } catch (e) {
        // get_apns_token wywali się na ne-iOS (cfg-gated zwraca None) —
        // wtedy debug log a nie warning, bo to expected.
        console.debug("[push] try register attempt", attempts, e);
      }
      if (attempts < MAX_ATTEMPTS && !cancelled) {
        timer = window.setTimeout(tryRegister, 5000);
      }
    };
    void tryRegister();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [settings.network?.token, settings.network?.server_url]);

  // VisualViewport — gdy klawiatura otwiera się na iOS, `window.visualViewport`
  // ma świeżą wysokość bez klawiatury. Eksportujemy ją jako CSS var `--vvh`
  // (i także offset top jako `--vvt`). `.gg-window` używa `--vvh` jako
  // height-u. Dzięki temu layout kurczy się z keyboard-em zamiast pchać
  // wszystko do góry pod toolbar.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // APNs deep-link: native iOS handler zapisał username do
  // `<Caches>/apns_pending_open.txt` gdy user tapnął notyfikację. Polluje-my
  // ten plik przy boot, focus i każdym ready event. Po odczycie Rust go
  // usuwa (read-once). Jak peer istnieje w naszej liście kontaktów, otwórz
  // z nim czat.
  const tryOpenPendingPeer = async () => {
    if (!settings.network?.token) return;
    try {
      const peer = await invoke<string | null>("get_apns_pending_open");
      if (!peer) return;
      const exists = contacts.some(
        (c) => c.username.toLowerCase() === peer.toLowerCase(),
      );
      if (exists) {
        onSelectPeer(peer);
      } else {
        console.warn("[push] pending peer not in contacts:", peer);
      }
    } catch (e) {
      console.debug("[push] get_apns_pending_open:", e);
    }
  };
  // Ref na latest version (closure dla event listenerów).
  const tryOpenPendingPeerRef = useRef(tryOpenPendingPeer);
  useEffect(() => {
    tryOpenPendingPeerRef.current = tryOpenPendingPeer;
  });
  useEffect(() => {
    void tryOpenPendingPeerRef.current();
    const onFocus = () => void tryOpenPendingPeerRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Diagnostyka: zaloguj każde zmniejszenie liczby wiadomości na peerze.
  // Pozwala złapać moment „znikania" w DevTools console.
  const prevPeerCountsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const counts: Record<string, number> = {};
    for (const [peer, list] of Object.entries(peerMessagesByPeer)) {
      counts[peer] = list.length;
    }
    for (const [peer, count] of Object.entries(counts)) {
      const prev = prevPeerCountsRef.current[peer] ?? 0;
      if (count < prev) {
        console.warn(
          `[diag] peer "${peer}": liczba wiadomości spadła ${prev} → ${count}. Stack trace poniżej.`,
        );
        console.trace();
      }
    }
    prevPeerCountsRef.current = counts;
  }, [peerMessagesByPeer]);

  // Idle detection: po 1 min bez aktywności (mouse/keyboard/touch/focus)
  // przełączamy status na AFK i informujemy server. Każda aktywność
  // resetuje timer; jeśli byliśmy AFK to wracamy na Online.
  const myStatusRef = useRef(myStatus);
  useEffect(() => {
    myStatusRef.current = myStatus;
  }, [myStatus]);
  useEffect(() => {
    const IDLE_MS = 60 * 1000;
    let idleTimer: number | null = null;

    const sendStatus = (status: "online" | "afk") => {
      if (myStatusRef.current === status) return;
      myStatusRef.current = status;
      setMyStatus(status);
      networkRef.current?.send({ type: "set_status", status });
    };

    const onActivity = () => {
      if (idleTimer != null) window.clearTimeout(idleTimer);
      // Po aktywności wracamy do online (jeśli byliśmy AFK).
      sendStatus("online");
      idleTimer = window.setTimeout(() => sendStatus("afk"), IDLE_MS);
    };

    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "wheel",
      "focus",
    ];
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });
    // Start z aktywności — pierwszy timer od razu.
    onActivity();

    return () => {
      if (idleTimer != null) window.clearTimeout(idleTimer);
      for (const e of events) window.removeEventListener(e, onActivity);
    };
  }, []);


  // KLUCZOWE: WS listener jest rejestrowany RAZ przy mount, więc closure
  // capture'uje pierwszy render — settings.network.account_id = null
  // (bo user jeszcze nie zalogowany). Przez to welcome/blob handler bail
  // out z 'if (!accountId) break'. Trzymamy najświeższy handler w refie
  // i wywołujemy przez niego, żeby każde wywołanie miało fresh closure.
  const networkHandlerRef = useRef<((event: NetEvent) => void) | null>(null);
  useEffect(() => {
    networkHandlerRef.current = (event) => handleNetworkEvent(event);
  });

  // Cache zdeszyfrowanych wiadomości w localStorage (per-account).
  // mls_decrypt jest stateful — drugi raz na tym samym ciphertext rzuca,
  // a klucze z secret tree są kasowane po użyciu. Więc gdy klient
  // restartuje się i fetchuje historię z serwera, blob-ów już nie
  // odczyta. Trzymamy plaintext lokalnie, ładujemy przy boot, zapisujemy
  // przy każdej zmianie peerMessagesByPeer (debounced).
  const peerMessagesSaveTimer = useRef<number | null>(null);
  useEffect(() => {
    const accountId = settings.network?.account_id;
    if (!accountId) return;
    if (peerMessagesSaveTimer.current != null) {
      window.clearTimeout(peerMessagesSaveTimer.current);
    }
    peerMessagesSaveTimer.current = window.setTimeout(() => {
      try {
        // Nie zapisujemy pending (tymczasowe tmp-id), żeby po restarcie
        // nie były zatwierdzane jako prawdziwe wiadomości.
        const sanitized: Record<string, PeerMessage[]> = {};
        for (const [peer, list] of Object.entries(peerMessagesByPeer)) {
          sanitized[peer] = list.filter((m) => !m.pending);
        }
        localStorage.setItem(
          `peer-msgs:${accountId}`,
          JSON.stringify(sanitized),
        );
      } catch (e) {
        console.warn("[storage] peer-msgs save:", e);
      }
    }, 250);
    return () => {
      if (peerMessagesSaveTimer.current != null) {
        window.clearTimeout(peerMessagesSaveTimer.current);
        peerMessagesSaveTimer.current = null;
      }
    };
  }, [peerMessagesByPeer, settings.network?.account_id]);

  // Serializacja przetwarzania per-peer — welcome MUSI się zakończyć
  // przed blob od tego samego peera, inaczej mls_decrypt nie znajdzie
  // group state.
  const peerQueueRef = useRef<Map<string, Promise<void>>>(new Map());
  const enqueueForPeer = (peer: string, fn: () => Promise<void>) => {
    const prev = peerQueueRef.current.get(peer) ?? Promise.resolve();
    const next = prev.then(fn).catch((e) => {
      console.warn("[mls queue]", peer, e);
    });
    peerQueueRef.current.set(peer, next);
  };

  const onInstallUpdate = async () => {
    if (!pendingUpdate) return;
    await installUpdate(pendingUpdate, setUpdateStatus);
    // Po sukcesie nastąpił `relaunch()`, więc tu nie dojdziemy.
  };
  const onDismissUpdate = () => {
    if (pendingUpdate) dismissedVersionRef.current = pendingUpdate.version;
    setPendingUpdate(null);
    setUpdateStatus({ state: "idle" });
  };

  const showNotice = (msg: string) => {
    setUpdateNotice(msg);
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setUpdateNotice(null), 4000);
  };

  const onCheckForUpdates = async () => {
    showNotice("Sprawdzam aktualizacje…");
    const pending = await checkForUpdate();
    if (pending) {
      // Manualne sprawdzenie kasuje dismissed flag — user wprost prosi o pokazanie.
      dismissedVersionRef.current = null;
      setPendingUpdate(pending);
      setUpdateNotice(null);
      if (noticeTimerRef.current != null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    } else {
      showNotice("Masz najnowszą wersję.");
    }
  };

  const switchActiveSession = async (modelId: string, sessionId: string | null) => {
    setActiveSessionByModel((prev) => ({ ...prev, [modelId]: sessionId }));
    if (sessionId && !messagesBySession[sessionId]) {
      const session = await loadSessionRpc(
        sessionId,
        settings.network.server_url,
        settings.network.token,
      );
      if (session) {
        setMessagesBySession((prev) => ({
          ...prev,
          [sessionId]: sessionToMessages(session),
        }));
      }
    }
  };

  const onSelectModel = async (id: string) => {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setActivePeerUsername(null);
    setActiveGroupId(null);
    setActiveModelId(id);
    if (!(id in activeSessionByModel)) {
      const latest = sessions.find((s) => s.modelId === id);
      if (latest) {
        await switchActiveSession(id, latest.id);
      } else {
        setActiveSessionByModel((prev) => ({ ...prev, [id]: null }));
      }
    }
  };

  const onSelectSession = async (id: string) => {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setActivePeerUsername(null);
    setActiveGroupId(null);
    // KLUCZOWE: sesja ma WŁASNY modelId. Wybór sesji musi przestawić
    // activeModelId na model TEJ sesji, inaczej onSend ostempluje ją
    // globalnym activeModelId i nadpisze model starej rozmowy.
    const meta = sessions.find((s) => s.id === id);
    const modelId = meta?.modelId ?? activeModelId;
    setActiveModelId(modelId);
    await switchActiveSession(modelId, id);
  };

  /** Nowa rozmowa z konkretnym modelem — atomowo (model + clear session).
   *  Zastępuje stary onSelectModel+onNewSession combo, który cierpiał na
   *  stale-closure (onNewSession czytał activeModelId sprzed setState-u). */
  const onStartNewSession = (modelId: string) => {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setActivePeerUsername(null);
    setActiveGroupId(null);
    setActiveModelId(modelId);
    setActiveSessionByModel((prev) => ({ ...prev, [modelId]: null }));
  };

  const onDeleteSession = async (id: string) => {
    await deleteSessionRpc(id, settings.network.server_url, settings.network.token);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setMessagesBySession((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActiveSessionByModel((prev) => {
      const next = { ...prev };
      for (const [mid, sid] of Object.entries(prev)) {
        if (sid === id) next[mid] = null;
      }
      return next;
    });
    setSessionMacrosBySession((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const onSettingsSaved = (s: Settings) => {
    setSettings(s);
    if (!s.network.token) {
      setContacts([]);
      setActivePeerUsername(null);
      setNetBootState("needs_login");
    } else {
      void refreshContacts(s.network.server_url, s.network.token);
      void refreshGroups(s.network.server_url, s.network.token);
      // Push API keys do servera — wszystkie providery (PUT z pustym body = clear).
      void pushSecrets(s.network.server_url, s.network.token, s);
      setNetBootState("logged_in");
    }
  };

  const refreshContacts = async (serverUrl: string, token: string) => {
    try {
      const list = await serverApi.listContacts(serverUrl, token);
      setContacts(list);
    } catch (e) {
      console.warn("[network] listContacts failed:", e);
    }
  };

  const refreshGroups = async (serverUrl: string, token: string) => {
    try {
      const list = await serverApi.listGroups(serverUrl, token);
      setGroups(list);
    } catch (e) {
      console.warn("[network] listGroups failed:", e);
    }
  };

  const refreshSessions = async (serverUrl: string, token: string) => {
    try {
      const list = await listSessions(serverUrl, token);
      setSessions(list);
    } catch (e) {
      console.warn("[network] listSessions failed:", e);
    }
  };

  const refreshSecrets = async (serverUrl: string, token: string) => {
    try {
      const rows = await serverApi.listSecrets(serverUrl, token);
      if (rows.length === 0) return;
      // Merge: server source-of-truth dla każdego providera którego MA. Jeśli
      // lokalnie był klucz a server nie ma, zostawiamy lokalny (push przy
      // następnym save). saveSettings persistuje na dysku.
      setSettings((cur) => {
        const next: Settings = JSON.parse(JSON.stringify(cur));
        for (const row of rows) {
          if (row.provider === "openai") {
            next.openai.auth = { mode: "api_key", api_key: row.api_key };
          } else if (row.provider === "anthropic") {
            next.anthropic.auth = { mode: "api_key", api_key: row.api_key };
          } else if (row.provider === "moonshot") {
            const baseUrl =
              cur.moonshot.auth.mode === "api_key"
                ? cur.moonshot.auth.base_url
                : null;
            next.moonshot.auth = {
              mode: "api_key",
              api_key: row.api_key,
              base_url: baseUrl,
            };
          }
        }
        void import("./lib/settings").then((m) => m.saveSettings(next));
        return next;
      });
    } catch (e) {
      console.warn("[network] listSecrets failed:", e);
    }
  };

  const pushSecrets = async (
    serverUrl: string,
    token: string,
    s: Settings,
  ) => {
    const pushOne = async (
      provider: "openai" | "anthropic" | "moonshot",
      key: string | undefined,
    ) => {
      try {
        await serverApi.updateSecret(serverUrl, token, provider, key ?? "");
      } catch (e) {
        console.warn(`[network] updateSecret ${provider}:`, e);
      }
    };
    const extract = (auth: { mode: string; api_key?: string }): string | undefined =>
      auth.mode === "api_key" ? auth.api_key : undefined;
    await Promise.all([
      pushOne("openai", extract(s.openai.auth as { mode: string; api_key?: string })),
      pushOne("anthropic", extract(s.anthropic.auth as { mode: string; api_key?: string })),
      pushOne("moonshot", extract(s.moonshot.auth as { mode: string; api_key?: string })),
    ]);
  };

  /**
   * Inicjalizuje MLS (klucz podpisujący) i upewnia się, że na serwerze
   * leży co najmniej `MIN_KP` KeyPackage'ów. Jeśli nie — generuje
   * `BATCH_KP` świeżych i publikuje. Wczytuje też lokalny rejestr grup
   * do mapowań w pamięci. Idempotentne.
   */
  const onAddedFriend = (c: ServerContact) => {
    setContacts((prev) => {
      if (prev.some((x) => x.peer_id === c.peer_id)) return prev;
      return [...prev, c].sort((a, b) => a.username.localeCompare(b.username));
    });
  };

  const onRemoveFriend = async (c: ServerContact) => {
    if (!settings.network.token) return;
    try {
      await serverApi.removeContact(settings.network.server_url, settings.network.token, c.peer_id);
      setContacts((prev) => prev.filter((x) => x.peer_id !== c.peer_id));
      if (activePeerUsername === c.username) setActivePeerUsername(null);
      // Wyczyść cache MLS po stronie klienta. Jeśli user ponownie doda
      // tego znajomego, ensureGroupWithPeer nie zobaczy stałego
      // peerGroupRef i wyśle nowy Welcome → przywrócenie konwersacji.
      const usernameLower = c.username.toLowerCase();
      const oldGroupId = peerGroupRef.current.get(usernameLower);
      peerGroupRef.current.delete(usernameLower);
      if (oldGroupId) groupPeerRef.current.delete(oldGroupId);
      setPeerMessagesByPeer((prev) => {
        if (!(c.username in prev)) return prev;
        const next = { ...prev };
        delete next[c.username];
        return next;
      });
      historyLoadedFor.current.delete(c.username);
      setUnreadByPeer((prev) => {
        if (!(c.username in prev)) return prev;
        const next = { ...prev };
        delete next[c.username];
        return next;
      });
    } catch (e) {
      console.warn("[network] removeContact failed:", e);
    }
  };

  // ─────────── NetworkClient lifecycle (Phase 2B.3)

  useEffect(() => {
    const client = new NetworkClient({
      serverUrl: settings.network.server_url,
      token: settings.network.token,
    });
    networkRef.current = client;

    const unsubStatus = client.onStatus(setWsStatus);
    const unsubStats = client.onStats(setNetStats);
    // Wywołujemy zawsze najświeższą wersję handlera (z aktualnym settings).
    const unsub = client.on((event) => networkHandlerRef.current?.(event));

    if (settings.network.token) client.connect();

    return () => {
      unsub();
      unsubStatus();
      unsubStats();
      client.disconnect();
      networkRef.current = null;
    };
    // ESLint eskaluje na settings, ale chcemy tylko jeden instans NetworkClient
    // przez całe życie komponentu. Konfig podajemy przez updateConfig poniżej.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect przy zmianie tokena/serverUrl
  useEffect(() => {
    const client = networkRef.current;
    if (!client) return;
    client.updateConfig({
      serverUrl: settings.network.server_url,
      token: settings.network.token,
    });
    if (settings.network.token) {
      client.connect();
    } else {
      client.disconnect();
    }
  }, [settings.network.server_url, settings.network.token]);

  const handleNetworkEvent = (event: NetEvent) => {
    switch (event.type) {
      case "ready": {
        // Po połączeniu: refresh kontaktów + history aktywnego peera.
        // Mark lastReadyAt — używamy w case "message" żeby nie playNotify-ć
        // dla wiadomości flushed z offline queue (dotarły jako push gdy
        // user był offline, dźwięk już zagrał na native banner).
        lastReadyAtRef.current = Date.now();
        if (settings.network.token) {
          void refreshContacts(settings.network.server_url, settings.network.token);
          void refreshGroups(settings.network.server_url, settings.network.token);
          void refreshSessions(settings.network.server_url, settings.network.token);
          const peer = activePeerUsernameRef.current;
          if (peer) void ensurePeerHistoryLoaded(peer);
        }
        break;
      }
      case "presence": {
        // status: stary serwer go nie wyśle — derive z `online`. Nowy server
        // zawsze daje online/afk/offline.
        const derivedStatus =
          event.status ?? (event.online ? "online" : "offline");
        setContacts((prev) =>
          prev.map((c) =>
            c.username === event.username
              ? { ...c, online: event.online, status: derivedStatus }
              : c,
          ),
        );
        break;
      }
      case "contacts_changed": {
        // Lista kontaktów się zmieniła (dodał mnie ktoś, ktoś mnie usunął,
        // moje inne urządzenie coś zmieniło). Refresh przez REST.
        if (settings.network.token) {
          void refreshContacts(settings.network.server_url, settings.network.token);
        }
        break;
      }
      case "groups_changed": {
        // Analogicznie dla grup.
        if (settings.network.token) {
          void refreshGroups(settings.network.server_url, settings.network.token);
        }
        break;
      }
      case "group_typing": {
        const gid = event.group_id;
        const who = event.from;
        if (event.state === "start") {
          setTypingByGroup((prev) => {
            const cur = new Set(prev[gid] ?? []);
            cur.add(who);
            return { ...prev, [gid]: cur };
          });
          const key = `${gid}:${who}`;
          const existing = groupTypingTimersRef.current.get(key);
          if (existing != null) window.clearTimeout(existing);
          const t = window.setTimeout(() => {
            setTypingByGroup((prev) => {
              const cur = new Set(prev[gid] ?? []);
              cur.delete(who);
              return { ...prev, [gid]: cur };
            });
            groupTypingTimersRef.current.delete(key);
          }, 6000);
          groupTypingTimersRef.current.set(key, t);
        } else {
          setTypingByGroup((prev) => {
            const cur = new Set(prev[gid] ?? []);
            cur.delete(who);
            return { ...prev, [gid]: cur };
          });
          const key = `${gid}:${who}`;
          const existing = groupTypingTimersRef.current.get(key);
          if (existing != null) {
            window.clearTimeout(existing);
            groupTypingTimersRef.current.delete(key);
          }
        }
        break;
      }
      case "typing": {
        // Auto-expire po 6s na wypadek gdyby peer się rozłączył w trakcie
        // pisania (server normalnie wysłałby presence offline → typing
        // implicit stop, ale to defense in depth).
        if (event.state === "start") {
          setTypingByPeer((prev) => ({ ...prev, [event.from]: true }));
          const existing = typingTimersRef.current.get(event.from);
          if (existing != null) window.clearTimeout(existing);
          const t = window.setTimeout(() => {
            setTypingByPeer((prev) => ({ ...prev, [event.from]: false }));
            typingTimersRef.current.delete(event.from);
          }, 6000);
          typingTimersRef.current.set(event.from, t);
        } else {
          setTypingByPeer((prev) => ({ ...prev, [event.from]: false }));
          const existing = typingTimersRef.current.get(event.from);
          if (existing != null) {
            window.clearTimeout(existing);
            typingTimersRef.current.delete(event.from);
          }
        }
        break;
      }
      case "message": {
        const peer = event.from;
        const msg: PeerMessage = {
          id: event.id,
          from_me: false,
          body: event.body,
          created_at: event.created_at,
          pending: false,
        };
        const isNew = !(peerMessagesByPeer[peer] ?? []).some(
          (m) => m.id === msg.id,
        );
        setPeerMessagesByPeer((prev) => {
          const cur = prev[peer] ?? [];
          if (cur.some((m) => m.id === msg.id)) return prev;
          return { ...prev, [peer]: [...cur, msg] };
        });
        if (activePeerUsernameRef.current !== peer) {
          setUnreadByPeer((prev) => ({ ...prev, [peer]: (prev[peer] ?? 0) + 1 }));
        }
        // Dźwięk tylko dla TRULY live wiadomości. Pomiń jeśli:
        //  - to flush z offline queue (created_at sprzed naszego ostatniego
        //    ready event-u → APNs banner już zagrał na mobile),
        //  - albo wiadomość już była w state (np. po history fetch).
        const createdAtMs = new Date(event.created_at).getTime();
        const isFromFlushQueue = createdAtMs < lastReadyAtRef.current - 1000;
        if (isNew && !isFromFlushQueue) {
          playNotify();
        }
        // Ack dopiero po dodaniu do state (idempotentne via id check).
        networkRef.current?.send({ type: "ack_delivery", message_id: event.id });
        break;
      }
      case "sent": {
        // Echo wysłanej wiadomości. Dwa scenariusze:
        //  (a) wysłaliśmy z TEGO device-a → mamy tmp z client_msg_id, robimy
        //      swap na server id.
        //  (b) wysłaliśmy z INNEGO device-a tego samego konta → nie mamy
        //      tmp, wstawiamy świeżą from_me z body z serwera (multi-device
        //      sync). `body` od v0.13.2 — stary serwer go nie pośle, więc
        //      jeśli brak, fallback do "(wysłane z innego urządzenia)".
        const peer = event.to;
        setPeerMessagesByPeer((prev) => {
          const cur = prev[peer] ?? [];
          const matchedLocally = !!(
            event.client_msg_id &&
            cur.some((m) => m.client_msg_id === event.client_msg_id)
          );
          if (matchedLocally) {
            const next = cur.map((m) => {
              if (event.client_msg_id && m.client_msg_id === event.client_msg_id) {
                return {
                  ...m,
                  id: event.id,
                  created_at: event.created_at,
                  pending: false,
                };
              }
              return m;
            });
            return { ...prev, [peer]: next };
          }
          // (b) — inne urządzenie. Sprawdź jeszcze, czy nie mamy już tego
          // server-id (np. po history refetch), żeby nie dublować.
          if (cur.some((m) => m.id === event.id)) return prev;
          const msg: PeerMessage = {
            id: event.id,
            from_me: true,
            body: event.body ?? "(wiadomość z innego urządzenia)",
            created_at: event.created_at,
            pending: false,
          };
          return { ...prev, [peer]: [...cur, msg] };
        });
        break;
      }
      case "group_message": {
        // Nowa wiadomość w grupie. Z tym samym kontraktem co peer "message":
        // dedup po id, increment unread gdy nie aktywna grupa, suppress
        // sound gdy stara (z flush queue).
        const gid = event.group_id;
        const msg: PeerMessage = {
          id: event.id,
          from_me: false,
          body: event.body,
          created_at: event.created_at,
          pending: false,
          // groupSender hack: zapisujemy username nadawcy w polu które na
          // ekranie pokażemy jako "Nick:" przed treścią.
          groupSender: event.from,
        };
        const isNew = !(groupMessagesByGroup[gid] ?? []).some(
          (m) => m.id === msg.id,
        );
        setGroupMessagesByGroup((prev) => {
          const cur = prev[gid] ?? [];
          if (cur.some((m) => m.id === msg.id)) return prev;
          return { ...prev, [gid]: [...cur, msg] };
        });
        if (activeGroupIdRef.current !== gid) {
          setUnreadByGroup((prev) => ({ ...prev, [gid]: (prev[gid] ?? 0) + 1 }));
        }
        const createdAtMs = new Date(event.created_at).getTime();
        const isFromFlushQueue = createdAtMs < lastReadyAtRef.current - 1000;
        if (isNew && !isFromFlushQueue) {
          playNotify();
        }
        break;
      }
      case "sent_group": {
        // Echo wysłanej wiadomości grupowej. Analog "sent" — swap tmp na
        // server id, albo insert from-me jeśli z innego device-a.
        const gid = event.group_id;
        setGroupMessagesByGroup((prev) => {
          const cur = prev[gid] ?? [];
          const matchedLocally = !!(
            event.client_msg_id &&
            cur.some((m) => m.client_msg_id === event.client_msg_id)
          );
          if (matchedLocally) {
            const next = cur.map((m) => {
              if (event.client_msg_id && m.client_msg_id === event.client_msg_id) {
                return {
                  ...m,
                  id: event.id,
                  created_at: event.created_at,
                  pending: false,
                };
              }
              return m;
            });
            return { ...prev, [gid]: next };
          }
          if (cur.some((m) => m.id === event.id)) return prev;
          const msg: PeerMessage = {
            id: event.id,
            from_me: true,
            body: event.body ?? "(wiadomość z innego urządzenia)",
            created_at: event.created_at,
            pending: false,
          };
          return { ...prev, [gid]: [...cur, msg] };
        });
        break;
      }
      case "sent_blob": {
        // Phase 3D: analog 'sent' dla MLS blob-ów.
        const peer = event.to;
        setPeerMessagesByPeer((prev) => {
          const cur = prev[peer] ?? [];
          const next = cur.map((m) => {
            if (event.client_msg_id && m.client_msg_id === event.client_msg_id) {
              return {
                ...m,
                id: event.id,
                created_at: event.created_at,
                pending: false,
              };
            }
            return m;
          });
          return { ...prev, [peer]: next };
        });
        break;
      }
      case "welcome": {
        // Phase 3D: peer założył z nami grupę MLS. Welcome musi się
        // przetworzyć PRZED jakimkolwiek blob-em od tego samego peera,
        // dlatego enqueue na per-peer chain.
        const accountId = settings.network.account_id;
        if (!accountId) {
          console.warn("[mls] welcome bez account_id — pomijam");
          break;
        }
        const sender = event.from;
        const ciphertext = event.ciphertext;
        const welcomeId = event.id;
        enqueueForPeer(sender, async () => {
          const resp = await mlsProcessWelcome(accountId, sender, ciphertext);
          peerGroupRef.current.set(sender.toLowerCase(), resp.group_id_b64);
          groupPeerRef.current.set(resp.group_id_b64, sender);
          console.info("[mls] joined grupa od", sender, "gid=", resp.group_id_b64);
          // Ack DOPIERO po sukcesie. Jeśli mls_process_welcome rzuci, ack
          // nie idzie, server zostawi welcome w queue → spróbuje znowu
          // przy następnym reconnect.
          networkRef.current?.send({ type: "ack_welcome", welcome_id: welcomeId });
        });
        break;
      }
      case "blob": {
        // Phase 3D: zaszyfrowana wiadomość MLS od peera. Enqueue na ten
        // sam chain co welcome (event.from), serializacja zapewnia że
        // welcome się skończył.
        const accountId = settings.network.account_id;
        if (!accountId) {
          console.warn("[mls] blob bez account_id — pomijam");
          break;
        }
        const sender = event.from;
        const groupId = event.group_id;
        const ciphertext = event.ciphertext;
        const eventId = event.id;
        const createdAt = event.created_at;
        const fallbackPeer = groupPeerRef.current.get(groupId) ?? sender;
        enqueueForPeer(sender, async () => {
          try {
            const resp = await mlsDecrypt(accountId, groupId, ciphertext);
            const peer = resp.sender_username ?? fallbackPeer;
            const msg: PeerMessage = {
              id: eventId,
              from_me: false,
              body: resp.plaintext,
              created_at: createdAt,
              pending: false,
              e2e: true,
            };
            setPeerMessagesByPeer((prev) => {
              const cur = prev[peer] ?? [];
              if (cur.some((m) => m.id === msg.id)) return prev;
              return { ...prev, [peer]: [...cur, msg] };
            });
            if (activePeerUsernameRef.current !== peer) {
              setUnreadByPeer((prev) => ({ ...prev, [peer]: (prev[peer] ?? 0) + 1 }));
            }
            playNotify();
            // Ack po sukcesie. Failed decrypt zostawia w queue do retry.
            networkRef.current?.send({ type: "ack_blob", blob_id: eventId });
          } catch (e) {
            console.error("[mls] decrypt failed:", e);
            const peer = fallbackPeer;
            const errMsg = e instanceof Error ? e.message : String(e);
            const friendly = errMsg.includes("grupa nie istnieje")
              ? "[E2E rozjechany — usuń tego znajomego i dodaj ponownie, żeby przywrócić rozmowę]"
              : `[E2E błąd: ${errMsg}]`;
            const msg: PeerMessage = {
              id: eventId,
              from_me: false,
              body: friendly,
              created_at: createdAt,
              pending: false,
              errored: true,
            };
            setPeerMessagesByPeer((prev) => {
              const cur = prev[peer] ?? [];
              if (cur.some((m) => m.id === msg.id)) return prev;
              return { ...prev, [peer]: [...cur, msg] };
            });
            // Też ack — bez tego server będzie walił tym samym blob-em
            // przy każdym reconnect, a my i tak go nie zdeszyfrujemy.
            // User dostał czytelny komunikat, więc OK.
            networkRef.current?.send({ type: "ack_blob", blob_id: eventId });
          }
        });
        break;
      }
      case "error": {
        console.warn("[network] server error:", event.code, event.message);
        break;
      }
      default:
        break;
    }
  };

  const ensurePeerHistoryLoaded = async (peerUsername: string) => {
    // Set-tracking dla pierwszego loadu nie blokuje kolejnych — multi-device
    // sync wymaga żeby zawsze refetchować na peer-select/reconnect. Dedup
    // jest po server-id w środku funkcji, więc re-fetch jest tani.
    if (!settings.network.token || !settings.network.account_id) return;
    historyLoadedFor.current.add(peerUsername);
    try {
      const list = await serverApi.fetchHistory(
        settings.network.server_url,
        settings.network.token,
        peerUsername,
        { limit: 50 },
      );
      const myId = settings.network.account_id;
      const accountId = myId;
      // Server zwraca DESC — odwracamy na ASC do wyświetlania.
      const asc = [...list].reverse();
      // KRYTYCZNE: mls_decrypt jest stateful — zużywa key z secret tree.
      // Drugi raz na tym samym ciphertext rzuca error. Jeśli więc dla
      // jakiegoś id mamy już zdeszyfrowaną wiadomość w pamięci (z live
      // WS event albo z poprzedniej iteracji), używamy cache zamiast
      // ponownie wołać mls_decrypt.
      const existingById = new Map<string, PeerMessage>();
      const cur = peerMessagesByPeer[peerUsername] ?? [];
      for (const m of cur) existingById.set(m.id, m);

      const decoded: PeerMessage[] = [];
      for (const e of asc) {
        const cached = existingById.get(e.id);
        if (cached && !cached.errored) {
          decoded.push(cached);
          continue;
        }
        if (e.kind === "plain") {
          decoded.push(plainEntryToPeer(e, myId));
        } else {
          try {
            const dec = await mlsDecrypt(accountId, e.group_id, e.ciphertext);
            decoded.push({
              id: e.id,
              from_me: e.from_id === myId,
              body: dec.plaintext,
              created_at: e.created_at,
              pending: false,
              e2e: true,
            });
          } catch (decryptErr) {
            console.warn("[mls] historic blob undecryptable:", decryptErr);
            decoded.push({
              id: e.id,
              from_me: e.from_id === myId,
              body: "[stara wiadomość — klucze rotowane]",
              created_at: e.created_at,
              pending: false,
              e2e: true,
              errored: true,
            });
          }
        }
      }
      setPeerMessagesByPeer((prev) => {
        const curNow = prev[peerUsername] ?? [];
        // Additive merge: zaczynamy od pełnego curNow (NIC nie dropujemy),
        // dorzucamy z decoded tylko te id-ki których jeszcze nie mamy. To
        // robi sync ale nigdy nie traci wiadomości w race-conditions
        // (równoległe fetche, setState z innym setterem między fetch a tym
        // callbackiem). Posortowane po created_at na końcu.
        const curIds = new Set(curNow.map((m) => m.id));
        const newcomers = decoded.filter((m) => !curIds.has(m.id));
        if (newcomers.length === 0) return prev;
        const merged = [...curNow, ...newcomers].sort((a, b) =>
          a.created_at.localeCompare(b.created_at),
        );
        return { ...prev, [peerUsername]: merged };
      });
    } catch (e) {
      console.warn("[network] history failed:", e);
      historyLoadedFor.current.delete(peerUsername);
    }
  };

  const onSelectPeer = (username: string) => {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setActivePeerUsername(username);
    setActiveGroupId(null);
    setUnreadByPeer((prev) => {
      if ((prev[username] ?? 0) === 0) return prev;
      return { ...prev, [username]: 0 };
    });
    void ensurePeerHistoryLoaded(username);
  };

  const ensureGroupHistoryLoaded = async (groupId: string) => {
    if (!settings.network.token || !settings.network.account_id) return;
    try {
      const list = await serverApi.fetchGroupHistory(
        settings.network.server_url,
        settings.network.token,
        groupId,
        { limit: 50 },
      );
      const myId = settings.network.account_id;
      const asc = [...list].reverse();
      const decoded: PeerMessage[] = asc.map((e) => ({
        id: e.id,
        from_me: e.sender_id === myId,
        body: e.body,
        created_at: e.created_at,
        pending: false,
        groupSender: e.sender_username,
      }));
      setGroupMessagesByGroup((prev) => {
        const curNow = prev[groupId] ?? [];
        const curIds = new Set(curNow.map((m) => m.id));
        const newcomers = decoded.filter((m) => !curIds.has(m.id));
        if (newcomers.length === 0) return prev;
        const merged = [...curNow, ...newcomers].sort((a, b) =>
          a.created_at.localeCompare(b.created_at),
        );
        return { ...prev, [groupId]: merged };
      });
    } catch (e) {
      console.warn("[network] group history failed:", e);
    }
  };

  const onSelectGroup = (groupId: string) => {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setActiveGroupId(groupId);
    setActivePeerUsername(null);
    setUnreadByGroup((prev) => {
      if ((prev[groupId] ?? 0) === 0) return prev;
      return { ...prev, [groupId]: 0 };
    });
    void ensureGroupHistoryLoaded(groupId);
  };

  const onGroupSend = (text: string) => {
    const gid = activeGroupId;
    if (!gid || !networkRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const tmpId = "tmp-" + Math.random().toString(36).slice(2, 10);
    const msg: PeerMessage = {
      id: tmpId,
      client_msg_id: tmpId,
      from_me: true,
      body: trimmed,
      created_at: new Date().toISOString(),
      pending: true,
    };
    setGroupMessagesByGroup((prev) => {
      const cur = prev[gid] ?? [];
      return { ...prev, [gid]: [...cur, msg] };
    });
    networkRef.current.send({
      type: "send_group_message",
      group_id: gid,
      body: trimmed,
      client_msg_id: tmpId,
    });
  };

  const onCreateGroup = async (name: string, memberUsernames: string[]) => {
    if (!settings.network.token) return;
    const created = await serverApi.createGroup(
      settings.network.server_url,
      settings.network.token,
      name,
      memberUsernames,
    );
    setGroups((prev) => [created, ...prev]);
    setCreateGroupOpen(false);
    onSelectGroup(created.id);
  };

  const onPeerSend = (text: string) => {
    // v0.10.0: rip out MLS — wysyłamy plain WS event `send`. Server zapisuje
    // do tabeli `messages` (plain text), peer odbiera przez `message` event.
    // Stare konwersacje MLS (sprzed v0.10.0) dalej działają dwukierunkowo,
    // bo legacy blob/welcome handlery zostają.
    const peer = activePeerUsername;
    if (!peer || !networkRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const tmpId = "tmp-" + Math.random().toString(36).slice(2, 10);
    const msg: PeerMessage = {
      id: tmpId,
      client_msg_id: tmpId,
      from_me: true,
      body: trimmed,
      created_at: new Date().toISOString(),
      pending: true,
    };
    setPeerMessagesByPeer((prev) => {
      const cur = prev[peer] ?? [];
      return { ...prev, [peer]: [...cur, msg] };
    });
    networkRef.current.send({
      type: "send",
      to: peer,
      body: trimmed,
      client_msg_id: tmpId,
    });
  };

  const onQuit = async () => {
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.warn("[quit]", e);
    }
  };

  const onLogout = async () => {
    const cleared: Settings = {
      ...settings,
      network: {
        ...settings.network,
        token: "",
        account_id: null,
        username: null,
        password: null,
      },
    };
    try {
      const settingsLib = await import("./lib/settings");
      await settingsLib.saveSettings(cleared);
    } catch (e) {
      console.warn("[logout] save:", e);
    }
    setSettings(cleared);
    setContacts([]);
    setActivePeerUsername(null);
    setPeerMessagesByPeer({});
    setUnreadByPeer({});
    setTypingByPeer({});
    setGroups([]);
    setActiveGroupId(null);
    setGroupMessagesByGroup({});
    setUnreadByGroup({});
    setSessions([]);
    setMessagesBySession({});
    setActiveSessionByModel({});
    clearSessionCache();
    setMyDescription("");
    setMyAvatar("");
    setMyJoinedAt("");
    setProfileDialog(null);
    if (descSaveTimerRef.current != null) {
      window.clearTimeout(descSaveTimerRef.current);
      descSaveTimerRef.current = null;
    }
    historyLoadedFor.current.clear();
    peerGroupRef.current.clear();
    groupPeerRef.current.clear();
    setNetBootState("needs_login");
  };

  // Ukryty input file do uploadu avatara — klikany imperatywnie z dialogu profilu.
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const triggerAvatarPicker = () => {
    avatarFileInputRef.current?.click();
  };
  const onAvatarFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // żeby ten sam plik dało się wybrać ponownie
    if (!file) return;
    if (!settings.network.token || !settings.network.server_url) return;
    try {
      const { prepareAvatarFromFile } = await import("./lib/avatar");
      const { dataUrl } = await prepareAvatarFromFile(file);
      setMyAvatar(dataUrl); // optymistycznie
      const updated = await serverApi.updateAvatar(
        settings.network.server_url,
        settings.network.token,
        dataUrl,
      );
      setMyAvatar(updated.avatar ?? "");
    } catch (err) {
      console.error("[avatar] upload failed:", err);
      alert(
        err instanceof Error
          ? `Nie udało się zaktualizować avatara: ${err.message}`
          : "Nie udało się zaktualizować avatara.",
      );
    }
  };

  /**
   * Aktualizuje opis profilu zalogowanego usera. Optymistyczna zmiana stanu
   * lokalnego + debounce 500ms na PUT /me/profile, żeby nie spamić serwera
   * przy każdym keystroke. Bez tokena (offline) tylko zmieniamy lokalny
   * stan, ale i tak nie ma kogo informować, więc ignorujemy.
   */
  const onDescriptionChange = (desc: string) => {
    setMyDescription(desc);
    if (descSaveTimerRef.current != null) {
      window.clearTimeout(descSaveTimerRef.current);
    }
    const token = settings.network?.token;
    const serverUrl = settings.network?.server_url;
    if (!token || !serverUrl) return;
    descSaveTimerRef.current = window.setTimeout(() => {
      void serverApi
        .updateProfile(serverUrl, token, desc)
        .catch((e) => {
          console.warn("[network] updateProfile failed:", e);
        });
    }, 500);
  };

  const sessionMacroKey = activeSessionId ?? PENDING_SESSION_KEY;
  const activeSessionMacroIds = sessionMacrosBySession[sessionMacroKey] ?? [];

  const onToggleSessionMacro = (macroId: string) => {
    setSessionMacrosBySession((prev) => {
      const cur = prev[sessionMacroKey] ?? [];
      const next = cur.includes(macroId)
        ? cur.filter((id) => id !== macroId)
        : [...cur, macroId];
      return { ...prev, [sessionMacroKey]: next };
    });
  };

  const onStop = () => {
    abortRef.current?.abort();
  };

  const onSend = async (text: string, images: ImageAttachment[]) => {
    const now = new Date();
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      modelId: activeModelId,
      text,
      timestamp: fmtTime(now),
      images: images.length > 0 ? images : undefined,
    };
    const assistantId = uid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      modelId: activeModelId,
      text: "",
      timestamp: fmtTime(new Date(now.getTime() + 1500)),
      streaming: true,
    };

    let sessionId = activeSessionId;
    let isNewSession = false;
    if (!sessionId) {
      sessionId = uid();
      isNewSession = true;
      const meta: SessionMeta = {
        id: sessionId,
        modelId: activeModelId,
        title: deriveTitle(text || (images.length > 0 ? "[obraz]" : "")),
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
        messageCount: 2,
      };
      setSessions((prev) => [meta, ...prev]);
      setActiveSessionByModel((prev) => ({ ...prev, [activeModelId]: sessionId! }));
      // Przenieś presety sesji z slotu PENDING na realny sessionId.
      setSessionMacrosBySession((prev) => {
        const pending = prev[PENDING_SESSION_KEY];
        if (!pending || pending.length === 0) return prev;
        const next = { ...prev };
        next[sessionId!] = pending;
        delete next[PENDING_SESSION_KEY];
        return next;
      });
    }

    const sid = sessionId;
    const baseMessages = messagesBySession[sid] ?? [];
    const nextMessages = [...baseMessages, userMsg, assistantMsg];
    setMessagesBySession((prev) => ({ ...prev, [sid]: nextMessages }));
    setIsStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    // Wstrzyknij aktywne presety sesji do tekstu wiadomości lecącej do API.
    // Widoczna `userMsg` w state i historii zapisywanej do dysku zostaje
    // dokładnie taka, jaką napisał user.
    const activeIds = sessionMacrosBySession[sid] ?? sessionMacrosBySession[PENDING_SESSION_KEY] ?? [];
    const activeSessionMacros = activeIds
      .map((id) => settings.macros.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => !!m && m.mode === "session");
    const wireText = augmentForApi(text, activeSessionMacros);
    const wireUserMsg: ChatMessage =
      wireText === text ? userMsg : { ...userMsg, text: wireText };
    const wireHistory = [...baseMessages, wireUserMsg];

    try {
      await streamChat({
        model: activeModel,
        history: wireHistory,
        signal: ac.signal,
        settings,
        onDelta: (chunk) => {
          setMessagesBySession((prev) => {
            const list = prev[sid] ?? [];
            return {
              ...prev,
              [sid]: list.map((m) =>
                m.id === assistantId ? { ...m, text: m.text + chunk } : m,
              ),
            };
          });
        },
      });
      playNotify();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // ignored
      } else {
        const message =
          err instanceof ProviderError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setMessagesBySession((prev) => {
          const list = prev[sid] ?? [];
          return {
            ...prev,
            [sid]: list.map((m) =>
              m.id === assistantId
                ? { ...m, text: `[Błąd] ${message}`, errored: true }
                : m,
            ),
          };
        });
      }
    } finally {
      setMessagesBySession((prev) => {
        const list = prev[sid] ?? [];
        return {
          ...prev,
          [sid]: list.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m,
          ),
        };
      });
      setIsStreaming(false);
      abortRef.current = null;

      const finalMessages = (await getLatest(sid, setMessagesBySession)) ?? [];
      const updatedAt = Date.now();
      const fallbackTitle = deriveTitle(text || (images.length > 0 ? "[obraz]" : ""));
      const session: ChatSession = {
        id: sid,
        modelId: activeModelId,
        title: isNewSession ? fallbackTitle : activeSessionMeta?.title ?? fallbackTitle,
        createdAt: isNewSession ? now.getTime() : activeSessionMeta?.createdAt ?? now.getTime(),
        updatedAt,
        messages: messagesToStored(finalMessages),
      };
      try {
        await saveSessionRpc(
          session,
          settings.network.server_url,
          settings.network.token,
        );
        setSessions((prev) => {
          const without = prev.filter((s) => s.id !== sid);
          return [
            {
              id: sid,
              modelId: activeModelId,
              title: session.title,
              createdAt: session.createdAt,
              updatedAt,
              messageCount: session.messages.length,
            },
            ...without,
          ];
        });
      } catch (e) {
        console.error("Nie udało się zapisać sesji", e);
      }
    }
  };

  // Doomer Style (theme "light") zachowuje klasyczny układ XP: pasek menu,
  // toolbar i statusbar. Pozostałe motywy używają nowego układu rail+panel.
  const classic = (settings.theme ?? "default") === "light";

  return (
    <div className="gg-window">
      <Titlebar title="Gaidu" />
      {classic && (
        <>
          <Menubar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenChangelog={() => setChangelogOpen(true)}
            onCheckForUpdates={onCheckForUpdates}
            onLogout={settings.network?.token ? onLogout : undefined}
            loggedInUsername={settings.network?.username ?? null}
            onQuit={onQuit}
          />
          <Toolbar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMacros={() => setMacrosOpen(true)}
            onOpenNetwork={() => setNetworkOpen(true)}
            onToggleSidebar={
              isMobile ? () => setSidebarMobileOpen((v) => !v) : undefined
            }
            onAddFriend={() => {
              if (settings.network?.token) {
                setAddFriendOpen(true);
              } else {
                setNetworkOpen(true);
              }
            }}
            networkOnline={wsStatus.kind === "connected"}
          />
        </>
      )}
      <div className="gg-body">
        {!classic && (
          <Rail
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMacros={() => setMacrosOpen(true)}
            onOpenNetwork={() => setNetworkOpen(true)}
            onOpenChangelog={() => setChangelogOpen(true)}
            onCheckForUpdates={onCheckForUpdates}
            onLogout={settings.network?.token ? onLogout : undefined}
            loggedInUsername={settings.network?.username ?? null}
            onQuit={onQuit}
            networkOnline={wsStatus.kind === "connected"}
            view={railView}
            onSelectView={(v) => {
              setRailView(v);
              // Wybór "AI" przełącza panel główny na czat AI; "komunikator"
              // tylko odsłania listę znajomych/grup (czat wybiera user).
              if (v === "ai") onSelectModel(activeModelId);
            }}
            onToggleSidebar={
              isMobile ? () => setSidebarMobileOpen((v) => !v) : undefined
            }
          />
        )}
        <Sidebar
          classic={classic}
          view={railView}
          models={MODELS}
          activeModelId={activeModelId}
          onSelectModel={(id) => {
            setRailView("ai");
            onSelectModel(id);
          }}
          configuredByModel={configuredByModel}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={(id) => {
            setRailView("ai");
            onSelectSession(id);
          }}
          onStartNewSession={(id) => {
            setRailView("ai");
            onStartNewSession(id);
          }}
          onDeleteSession={onDeleteSession}
          nick={settings.network?.username ?? undefined}
          presence={
            !settings.network?.token
              ? "logged_out"
              : wsStatus.kind === "connected"
                ? myStatus === "afk"
                  ? "afk"
                  : "online"
                : wsStatus.kind === "connecting" || wsStatus.kind === "reconnecting"
                  ? "connecting"
                  : "offline"
          }
          networkLoggedIn={!!settings.network.token && !!settings.network.username}
          contacts={contacts}
          activePeerUsername={activePeerUsername}
          onSelectPeer={(u) => {
            setRailView("messenger");
            onSelectPeer(u);
          }}
          onAddFriend={() => setAddFriendOpen(true)}
          onRemoveFriend={onRemoveFriend}
          unreadByPeer={unreadByPeer}
          groups={groups}
          activeGroupId={activeGroupId}
          onSelectGroup={(id) => {
            setRailView("messenger");
            onSelectGroup(id);
          }}
          onCreateGroup={() => setCreateGroupOpen(true)}
          unreadByGroup={unreadByGroup}
          avatar={myAvatar}
          onOpenProfile={
            settings.network?.token
              ? () => setProfileDialog({ mode: "self" })
              : undefined
          }
          description={myDescription}
          onDescriptionChange={
            settings.network?.token ? onDescriptionChange : undefined
          }
          onChangeAvatar={
            settings.network?.token
              ? () => setProfileDialog({ mode: "self" })
              : undefined
          }
          mobileOpen={isMobile && sidebarMobileOpen}
          onMobileClose={() => setSidebarMobileOpen(false)}
        />
        <main className="gg-main">
          {activeGroupId ? (
            <>
              <Conversation
                classic={classic}
                model={{
                  id: `group:${activeGroupId}`,
                  name: groups.find((g) => g.id === activeGroupId)?.name ?? "Grupa",
                  provider: "anthropic",
                  apiModelId: "",
                }}
                messages={peerToChatMessages(
                  groupMessagesByGroup[activeGroupId] ?? [],
                  groups.find((g) => g.id === activeGroupId)?.name ?? "Grupa",
                )}
                sessionTitle={(() => {
                  const typing = Array.from(typingByGroup[activeGroupId] ?? []);
                  if (typing.length === 1) return `${typing[0]} pisze…`;
                  if (typing.length > 1) return `${typing.length} osób pisze…`;
                  const g = groups.find((x) => x.id === activeGroupId);
                  return g ? `${g.member_count} osób` : "";
                })()}
                peerChat
                onPeerProfileClick={() => setGroupProfileOpen(true)}
              />
              <Composer
                disabled={false}
                isStreaming={false}
                enableEmotes
                onSend={(text) => onGroupSend(text)}
                onTypingChange={(typing) => {
                  if (!activeGroupId || !networkRef.current) return;
                  networkRef.current.send({
                    type: "typing_group",
                    group_id: activeGroupId,
                    state: typing ? "start" : "stop",
                  });
                }}
              />
            </>
          ) : activePeerUsername ? (
            <>
              <Conversation
                classic={classic}
                model={{
                  id: `peer:${activePeerUsername}`,
                  name: activePeerUsername,
                  provider: "anthropic",
                  apiModelId: "",
                }}
                messages={peerToChatMessages(
                  peerMessagesByPeer[activePeerUsername] ?? [],
                  activePeerUsername,
                )}
                sessionTitle={(() => {
                  // Status w nagłówku peer chat odzwierciedla obecność PEERA,
                  // nie naszego klienta. Jeśli my sami nie jesteśmy
                  // połączeni, pokazujemy tylko nasz stan (bo i tak nic
                  // nie wiemy o peerze gdy WS jest down).
                  if (wsStatus.kind === "reconnecting" || wsStatus.kind === "connecting") {
                    return "łączenie…";
                  }
                  if (wsStatus.kind !== "connected") {
                    return "brak połączenia";
                  }
                  if (typingByPeer[activePeerUsername]) return "pisze…";
                  const peerContact = contacts.find(
                    (c) => c.username.toLowerCase() === activePeerUsername.toLowerCase(),
                  );
                  if (!peerContact) return "offline";
                  if (peerContact.status === "afk") return "zaraz wraca";
                  if (peerContact.online) return "online";
                  if (peerContact.status === "push_reachable") return "mobile";
                  return "offline";
                })()}
                peerPresence={(() => {
                  if (
                    wsStatus.kind === "reconnecting" ||
                    wsStatus.kind === "connecting"
                  ) {
                    return "connecting";
                  }
                  if (wsStatus.kind !== "connected") return "offline";
                  const peerContact = contacts.find(
                    (c) => c.username.toLowerCase() === activePeerUsername.toLowerCase(),
                  );
                  if (!peerContact) return "offline";
                  if (peerContact.status === "afk") return "afk";
                  if (peerContact.online) return "online";
                  if (peerContact.status === "push_reachable") return "push_reachable";
                  return "offline";
                })()}
                peerUnread={unreadByPeer[activePeerUsername] ?? 0}
                peerChat
                onPeerProfileClick={() =>
                  setProfileDialog({ mode: "peer", username: activePeerUsername })
                }
              />
              <Composer
                disabled={false}
                isStreaming={false}
                enableEmotes
                onSend={(text) => onPeerSend(text)}
                onTypingChange={(typing) => {
                  if (!activePeerUsername || !networkRef.current) return;
                  networkRef.current.send({
                    type: "typing",
                    to: activePeerUsername,
                    state: typing ? "start" : "stop",
                  });
                }}
              />
            </>
          ) : (
            <>
              <Conversation
                classic={classic}
                model={activeModel}
                messages={messages}
                sessionTitle={activeSessionMeta?.title ?? null}
              />
              <Composer
                disabled={isStreaming}
                isStreaming={isStreaming}
                macros={settings.macros}
                activeSessionMacroIds={activeSessionMacroIds}
                onToggleSessionMacro={onToggleSessionMacro}
                onSend={onSend}
                onStop={onStop}
              />
            </>
          )}
        </main>
      </div>
      {classic && (
        <Statusbar
          net={
            !settings.network?.token
              ? "logged_out"
              : wsStatus.kind === "connected"
                ? "connected"
                : wsStatus.kind === "connecting" || wsStatus.kind === "reconnecting"
                  ? "connecting"
                  : "disconnected"
          }
        />
      )}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={onSettingsSaved}
      />
      <MacrosDialog
        open={macrosOpen}
        onClose={() => setMacrosOpen(false)}
        onSaved={onSettingsSaved}
      />
      <ChangelogDialog open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <NetworkAccountDialog
        open={networkOpen || netBootState === "needs_login"}
        forced={netBootState === "needs_login"}
        settings={settings}
        wsStatus={wsStatus}
        netStats={netStats ?? undefined}
        onClose={() => setNetworkOpen(false)}
        onSaved={onSettingsSaved}
      />
      {netBootState === "server_unreachable" && (
        <div className="gg-net-offline-banner" role="status">
          Sieć Gaidu chwilowo niedostępna. Możesz korzystać z chatów AI;
          rozmowy ze znajomymi wrócą gdy serwer się odezwie.
        </div>
      )}
      <AddFriendDialog
        open={addFriendOpen}
        serverUrl={settings.network.server_url}
        token={settings.network.token}
        onClose={() => setAddFriendOpen(false)}
        onAdded={onAddedFriend}
      />
      <CreateGroupDialog
        open={createGroupOpen}
        contacts={contacts}
        onClose={() => setCreateGroupOpen(false)}
        onSubmit={onCreateGroup}
      />
      <GroupProfileDialog
        open={groupProfileOpen}
        group={
          activeGroupId
            ? groups.find((g) => g.id === activeGroupId) ?? null
            : null
        }
        contacts={contacts}
        serverUrl={settings.network.server_url}
        token={settings.network.token}
        myAccountId={settings.network.account_id ?? null}
        onClose={() => setGroupProfileOpen(false)}
        onLeftOrDeleted={() => {
          setGroupProfileOpen(false);
          setActiveGroupId(null);
          if (settings.network.token) {
            void refreshGroups(settings.network.server_url, settings.network.token);
          }
        }}
      />
      <input
        ref={avatarFileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onAvatarFilePicked}
      />
      {profileDialog && (
        <UserProfileDialog
          open
          mode={profileDialog.mode}
          onClose={() => setProfileDialog(null)}
          data={(() => {
            if (profileDialog.mode === "self") {
              return {
                username: settings.network?.username ?? "",
                description: myDescription,
                avatar: myAvatar,
                joinedAt: myJoinedAt,
                presence:
                  !settings.network?.token
                    ? "logged_out"
                    : wsStatus.kind === "connected"
                      ? myStatus === "afk"
                        ? "afk"
                        : "online"
                      : wsStatus.kind === "connecting" || wsStatus.kind === "reconnecting"
                        ? "connecting"
                        : "offline",
              };
            }
            const peer = contacts.find(
              (c) => c.username.toLowerCase() === profileDialog.username.toLowerCase(),
            );
            return {
              username: profileDialog.username,
              nickname: peer?.nickname ?? null,
              description: peer?.description ?? "",
              avatar: peer?.avatar ?? "",
              joinedAt: peer?.created_at,
              presence:
                wsStatus.kind === "reconnecting" || wsStatus.kind === "connecting"
                  ? "connecting"
                  : !peer
                    ? "offline"
                    : peer.status === "afk"
                      ? "afk"
                      : peer.online
                        ? "online"
                        : "offline",
            };
          })()}
          onChangeAvatar={
            profileDialog.mode === "self" ? triggerAvatarPicker : undefined
          }
          onDescriptionChange={
            profileDialog.mode === "self" && settings.network?.token
              ? onDescriptionChange
              : undefined
          }
        />
      )}
      {pendingUpdate && (
        <UpdateToast
          pending={pendingUpdate}
          status={updateStatus}
          onInstall={onInstallUpdate}
          onDismiss={onDismissUpdate}
        />
      )}
      {updateNotice && !pendingUpdate && (
        <div className="gg-update-notice" role="status">
          {updateNotice}
        </div>
      )}
    </div>
  );
}

function getLatest(
  sid: string,
  setter: React.Dispatch<React.SetStateAction<Record<string, ChatMessage[]>>>,
): Promise<ChatMessage[] | undefined> {
  return new Promise((resolve) => {
    setter((prev) => {
      resolve(prev[sid]);
      return prev;
    });
  });
}

interface PeerMessage {
  /** Server UUID po `sent`/`message` lub lokalny tymczasowy "tmp-..." dopóki nie potwierdzony. */
  id: string;
  /** Tylko dla wiadomości wysłanych z tej apki — do korelacji `sent` echo. */
  client_msg_id?: string;
  from_me: boolean;
  body: string;
  created_at: string;
  pending?: boolean;
  errored?: boolean;
  /** True gdy wiadomość przeszła przez MLS encrypt/decrypt. False/undef = legacy plain. */
  e2e?: boolean;
  /** Tylko dla wiadomości grupowych — username nadawcy (do prefixu „Nick:"). */
  groupSender?: string;
}

function fmtPeerTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return "--:--:--";
  }
}

/** Mapuje listę PeerMessage na format ChatMessage używany przez Conversation. */
function peerToChatMessages(list: PeerMessage[], peerUsername: string): ChatMessage[] {
  const modelId = `peer:${peerUsername}`;
  return list.map((m) => {
    // Group chat ma N nadawców — nick nadawcy idzie do `author` (nagłówek
    // dymka), nie do treści. Peer chat (1:1) zostawia `author` pusty —
    // Conversation użyje wtedy nazwy modelu/peera.
    return {
      id: m.id,
      role: m.from_me ? "user" : "assistant",
      modelId,
      text: m.body,
      timestamp: fmtPeerTime(m.created_at),
      streaming: false,
      errored: m.errored,
      e2e: m.e2e,
      author: m.groupSender && !m.from_me ? m.groupSender : undefined,
    };
  });
}

function plainEntryToPeer(
  e: HistoryEntry & { kind: "plain" },
  myAccountId: string | null | undefined,
): PeerMessage {
  return {
    id: e.id,
    from_me: !!myAccountId && e.from_id === myAccountId,
    body: e.body,
    created_at: e.created_at,
    pending: false,
    e2e: false,
  };
}

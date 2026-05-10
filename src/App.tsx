import { useEffect, useMemo, useRef, useState } from "react";
import { Titlebar } from "./components/Titlebar";
import { Menubar } from "./components/Menubar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { Statusbar } from "./components/Statusbar";
import { SettingsDialog } from "./components/Settings";
import { MacrosDialog } from "./components/MacrosDialog";
import { UpdateToast } from "./components/UpdateToast";
import { ChangelogDialog } from "./components/ChangelogDialog";
import { ProfileDialog } from "./components/ProfileDialog";
import { NetworkAccountDialog } from "./components/NetworkAccountDialog";
import { AddFriendDialog } from "./components/AddFriendDialog";
import * as serverApi from "./lib/serverApi";
import type { ServerContact, ServerMessage } from "./lib/serverApi";
import { NetworkClient, type ConnectionStatus, type ServerEvent as NetEvent } from "./lib/network";
import {
  mlsInit,
  mlsGenerateKeyPackages,
  mlsListGroups,
  mlsCreateGroupWithPeer,
  mlsProcessWelcome,
  mlsEncrypt,
  mlsDecrypt,
} from "./lib/mls";
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
import { saveSettings } from "./lib/settings";
import {
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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForcedFirstRun, setProfileForcedFirstRun] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [contacts, setContacts] = useState<ServerContact[]>([]);
  const [activePeerUsername, setActivePeerUsername] = useState<string | null>(null);
  const [peerMessagesByPeer, setPeerMessagesByPeer] = useState<Record<string, PeerMessage[]>>({});
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({ kind: "idle" });
  const [typingByPeer, setTypingByPeer] = useState<Record<string, boolean>>({});
  const typingTimersRef = useRef<Map<string, number>>(new Map());
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const activePeerUsernameRef = useRef<string | null>(null);
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
      const [s, sess] = await Promise.all([loadSettings(), listSessions()]);
      setSettings(s);
      setSessions(sess);
      if (!s.profile?.nick || s.profile.nick.trim().length === 0) {
        setProfileForcedFirstRun(true);
        setProfileOpen(true);
      }
      // Walidacja JWT przy starcie. Jeśli nieważny → wyczyść z settings,
      // żeby przy następnym otwarciu NetworkAccountDialog user widział
      // formularz logowania zamiast „już zalogowany".
      if (s.network?.token && s.network.server_url) {
        try {
          const me = await serverApi.me(s.network.server_url, s.network.token);
          // Token OK → załaduj listę znajomych + zapewnij MLS identity.
          void refreshContacts(s.network.server_url, s.network.token);
          void ensureMlsReady(s.network.server_url, s.network.token, me.id);
        } catch (e) {
          if (e instanceof serverApi.ServerError && e.status === 401) {
            console.warn("[network] zapisany token jest nieważny, czyszczę");
            const cleared = {
              ...s,
              network: { ...s.network, token: "", account_id: null, username: null },
            };
            await import("./lib/settings").then((m) => m.saveSettings(cleared));
            setSettings(cleared);
          } else {
            // Serwer down albo network error — zostawiamy token, spróbujemy później.
            console.info("[network] /me check skipped:", e);
          }
        }
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
      // Wyczyść typing-timery przy unmount.
      for (const t of typingTimersRef.current.values()) window.clearTimeout(t);
      typingTimersRef.current.clear();
      abortRef.current?.abort();
    };
  }, []);

  // Trzymaj refy w sync z aktualnym state'em, żeby callback z setIntervala
  // używał świeżych wartości bez wymuszania re-rejestracji.
  useEffect(() => {
    pendingUpdateRef.current = pendingUpdate;
  }, [pendingUpdate]);

  useEffect(() => {
    activePeerUsernameRef.current = activePeerUsername;
  }, [activePeerUsername]);

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
      const session = await loadSessionRpc(sessionId);
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
    await switchActiveSession(activeModelId, id);
  };

  const onNewSession = () => {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setActiveSessionByModel((prev) => ({ ...prev, [activeModelId]: null }));
  };

  const onDeleteSession = async (id: string) => {
    await deleteSessionRpc(id);
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
    // Po (wy)logowaniu odświeżamy lub czyścimy listę kontaktów.
    if (!s.network.token) {
      setContacts([]);
      setActivePeerUsername(null);
    } else {
      void refreshContacts(s.network.server_url, s.network.token);
      if (s.network.account_id) {
        void ensureMlsReady(s.network.server_url, s.network.token, s.network.account_id);
      }
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

  /**
   * Inicjalizuje MLS (klucz podpisujący) i upewnia się, że na serwerze
   * leży co najmniej `MIN_KP` KeyPackage'ów. Jeśli nie — generuje
   * `BATCH_KP` świeżych i publikuje. Wczytuje też lokalny rejestr grup
   * do mapowań w pamięci. Idempotentne.
   */
  const ensureMlsReady = async (
    serverUrl: string,
    token: string,
    accountId: string,
  ) => {
    const MIN_KP = 3;
    const BATCH_KP = 10;
    try {
      const identity = await mlsInit(accountId);
      if (identity.freshly_created) {
        console.info("[mls] nowa tożsamość MLS dla", accountId);
      }
      // Wczytaj wszystkie grupy do mapowań w pamięci.
      const groups = await mlsListGroups(accountId);
      peerGroupRef.current.clear();
      groupPeerRef.current.clear();
      for (const g of groups) {
        peerGroupRef.current.set(g.peer_username.toLowerCase(), g.group_id_b64);
        groupPeerRef.current.set(g.group_id_b64, g.peer_username);
      }
      const { unconsumed } = await serverApi.keyPackagesCount(serverUrl, token);
      if (unconsumed < MIN_KP) {
        const need = BATCH_KP;
        const fresh = await mlsGenerateKeyPackages(accountId, need);
        const resp = await serverApi.publishKeyPackages(serverUrl, token, fresh);
        console.info(
          "[mls] uzupełniłem KP: +%d, total na serwerze: %d",
          resp.stored,
          resp.total_unconsumed,
        );
      }
    } catch (e) {
      console.warn("[mls] init/keypackage flow nie udał się:", e);
    }
  };

  /**
   * Zwraca group_id_b64 dla rozmowy z `peerUsername`. Jeśli grupa
   * jeszcze nie istnieje, próbuje ją założyć: claim KeyPackage peera,
   * mls_create_group_with_peer, send_welcome przez WS. Po sukcesie zwraca
   * group_id; przy braku KP/peer-a rzuca z czytelnym komunikatem.
   */
  const ensureGroupWithPeer = async (peerUsername: string): Promise<string> => {
    const accountId = settings.network.account_id;
    const token = settings.network.token;
    const serverUrl = settings.network.server_url;
    if (!accountId || !token) {
      throw new Error("nie jesteś zalogowany na serwerze GAIdu");
    }
    const cached = peerGroupRef.current.get(peerUsername.toLowerCase());
    if (cached) return cached;

    const claim = await serverApi.claimKeyPackage(serverUrl, token, peerUsername);
    const created = await mlsCreateGroupWithPeer(
      accountId,
      claim.username,
      claim.data,
    );
    peerGroupRef.current.set(claim.username.toLowerCase(), created.group_id_b64);
    groupPeerRef.current.set(created.group_id_b64, claim.username);

    // Wyślij Welcome do peera. send_welcome jest fire-and-forget;
    // serwer enqueue'uje gdyby peer był offline.
    networkRef.current?.send({
      type: "send_welcome",
      to: claim.username,
      ciphertext: created.welcome_b64,
    });
    return created.group_id_b64;
  };

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
    } catch (e) {
      console.warn("[network] removeContact failed:", e);
    }
  };

  const onSaveNick = async (nick: string) => {
    const next: Settings = { ...settings, profile: { ...settings.profile, nick } };
    await saveSettings(next);
    setSettings(next);
    setProfileOpen(false);
    setProfileForcedFirstRun(false);
  };

  const onCancelProfile = () => {
    if (profileForcedFirstRun) return;
    setProfileOpen(false);
  };

  // ─────────── NetworkClient lifecycle (Phase 2B.3)

  useEffect(() => {
    const client = new NetworkClient({
      serverUrl: settings.network.server_url,
      token: settings.network.token,
    });
    networkRef.current = client;

    const unsubStatus = client.onStatus(setWsStatus);
    const unsub = client.on((event) => handleNetworkEvent(event));

    if (settings.network.token) client.connect();

    return () => {
      unsub();
      unsubStatus();
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
        // Po połączeniu refresh kontaktów (świeże flagi online).
        if (settings.network.token) {
          void refreshContacts(settings.network.server_url, settings.network.token);
        }
        break;
      }
      case "presence": {
        setContacts((prev) =>
          prev.map((c) =>
            c.username === event.username ? { ...c, online: event.online } : c,
          ),
        );
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
        setPeerMessagesByPeer((prev) => {
          const cur = prev[peer] ?? [];
          // Idempotent: jeśli już mamy to id (z history), nie duplikuj.
          if (cur.some((m) => m.id === msg.id)) return prev;
          return { ...prev, [peer]: [...cur, msg] };
        });
        if (activePeerUsernameRef.current !== peer) {
          setUnreadByPeer((prev) => ({ ...prev, [peer]: (prev[peer] ?? 0) + 1 }));
        }
        playNotify();
        break;
      }
      case "sent": {
        // Echo wysłanej wiadomości — zamień tymczasowy id na server id.
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
        // Phase 3D: peer założył z nami grupę MLS. Przetwarzamy Welcome,
        // wpisujemy do mappingów. Po tym kolejne 'blob' od tego peera
        // będą deszyfrowalne.
        const accountId = settings.network.account_id;
        if (!accountId) break;
        void (async () => {
          try {
            const resp = await mlsProcessWelcome(accountId, event.from, event.ciphertext);
            peerGroupRef.current.set(event.from.toLowerCase(), resp.group_id_b64);
            groupPeerRef.current.set(resp.group_id_b64, event.from);
            console.info("[mls] joinedgrupa od", event.from, "gid=", resp.group_id_b64);
          } catch (e) {
            console.error("[mls] process_welcome failed:", e);
          }
        })();
        break;
      }
      case "blob": {
        // Phase 3D: zaszyfrowana wiadomość MLS od peera. Deszyfruj i
        // dodaj do peerMessagesByPeer pod kluczem peer username
        // (z 'event.from' lub naszego mappingu group_id → peer).
        const accountId = settings.network.account_id;
        if (!accountId) break;
        const fallbackPeer = groupPeerRef.current.get(event.group_id) ?? event.from;
        void (async () => {
          try {
            const resp = await mlsDecrypt(
              accountId,
              event.group_id,
              event.ciphertext,
            );
            const peer = resp.sender_username ?? fallbackPeer;
            const msg: PeerMessage = {
              id: event.id,
              from_me: false,
              body: resp.plaintext,
              created_at: event.created_at,
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
          } catch (e) {
            console.error("[mls] decrypt failed:", e);
            // Fallback: pokazujemy placeholder, żeby user wiedział, że
            // coś przyszło, ale nie udało się zdeszyfrować (np. brak
            // welcome jeszcze, desync epoki).
            const peer = fallbackPeer;
            const errMsg = e instanceof Error ? e.message : String(e);
            const msg: PeerMessage = {
              id: event.id,
              from_me: false,
              body: `[E2E błąd deszyfrowania: ${errMsg}]`,
              created_at: event.created_at,
              pending: false,
              errored: true,
            };
            setPeerMessagesByPeer((prev) => {
              const cur = prev[peer] ?? [];
              if (cur.some((m) => m.id === msg.id)) return prev;
              return { ...prev, [peer]: [...cur, msg] };
            });
          }
        })();
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
    if (historyLoadedFor.current.has(peerUsername)) return;
    if (!settings.network.token) return;
    historyLoadedFor.current.add(peerUsername);
    try {
      const list = await serverApi.fetchHistory(
        settings.network.server_url,
        settings.network.token,
        peerUsername,
        { limit: 50 },
      );
      const myId = settings.network.account_id ?? null;
      // Server zwraca DESC — odwracamy na ASC dla wyświetlania.
      const asc = [...list].reverse().map((m) => serverMsgToPeer(m, myId));
      setPeerMessagesByPeer((prev) => {
        const cur = prev[peerUsername] ?? [];
        // Merge zachowując już-wczytane pending wiadomości na końcu.
        const seenIds = new Set(asc.map((m) => m.id));
        const trailing = cur.filter((m) => m.pending || !seenIds.has(m.id));
        return { ...prev, [peerUsername]: [...asc, ...trailing] };
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
    setUnreadByPeer((prev) => {
      if ((prev[username] ?? 0) === 0) return prev;
      return { ...prev, [username]: 0 };
    });
    void ensurePeerHistoryLoaded(username);
  };

  const onPeerSend = async (text: string) => {
    const peer = activePeerUsername;
    const accountId = settings.network.account_id;
    if (!peer || !networkRef.current || !accountId) return;
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
      e2e: true,
    };
    setPeerMessagesByPeer((prev) => {
      const cur = prev[peer] ?? [];
      return { ...prev, [peer]: [...cur, msg] };
    });

    // Phase 3D: szyfrujemy wiadomość przez MLS, wysyłamy jako blob.
    // Pierwsza wiadomość z peerem inicjuje grupę: claim KP → create →
    // send_welcome → encrypt → send_blob.
    try {
      const groupId = await ensureGroupWithPeer(peer);
      const enc = await mlsEncrypt(accountId, groupId, trimmed);
      networkRef.current.send({
        type: "send_blob",
        to: peer,
        group_id: groupId,
        epoch: enc.epoch,
        ciphertext: enc.ciphertext_b64,
        client_msg_id: tmpId,
      });
    } catch (e) {
      console.error("[mls] encrypt+send failed", e);
      const errMsg = e instanceof Error ? e.message : String(e);
      setPeerMessagesByPeer((prev) => {
        const cur = prev[peer] ?? [];
        return {
          ...prev,
          [peer]: cur.map((m) =>
            m.id === tmpId
              ? { ...m, pending: false, errored: true, body: m.body + `\n\n[wysyłka E2E padła: ${errMsg}]` }
              : m,
          ),
        };
      });
    }
  };

  const onQuit = async () => {
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.warn("[quit]", e);
    }
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
        await saveSessionRpc(session);
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

  return (
    <div className="gg-window">
      <Titlebar title="GAIdu GAIdu 10" />
      <Menubar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenChangelog={() => setChangelogOpen(true)}
        onCheckForUpdates={onCheckForUpdates}
        onQuit={onQuit}
      />
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMacros={() => setMacrosOpen(true)}
        onOpenNetwork={() => setNetworkOpen(true)}
        networkOnline={wsStatus.kind === "connected"}
      />
      <div className="gg-body">
        <Sidebar
          models={MODELS}
          activeModelId={activeModelId}
          onSelectModel={onSelectModel}
          configuredByModel={configuredByModel}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
          onDeleteSession={onDeleteSession}
          nick={
            // Po zalogowaniu na serwer GAIdu używamy network.username jako
            // główną tożsamość (to taki nasz „GG-numerek"). Lokalny nick
            // z ProfileDialog dalej żyje jako fallback dla offline-only
            // użytkowników, którzy nigdy nie zakładają konta sieciowego.
            settings.network?.username ||
            settings.profile?.nick ||
            undefined
          }
          onEditProfile={() => {
            setProfileForcedFirstRun(false);
            setProfileOpen(true);
          }}
          networkLoggedIn={!!settings.network.token && !!settings.network.username}
          contacts={contacts}
          activePeerUsername={activePeerUsername}
          onSelectPeer={onSelectPeer}
          onAddFriend={() => setAddFriendOpen(true)}
          onRemoveFriend={onRemoveFriend}
          unreadByPeer={unreadByPeer}
        />
        <main className="gg-main">
          {activePeerUsername ? (
            <>
              <Conversation
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
                sessionTitle={
                  typingByPeer[activePeerUsername]
                    ? "pisze…"
                    : wsStatus.kind === "connected"
                      ? "online"
                      : wsStatus.kind === "reconnecting"
                        ? "łączenie…"
                        : "offline"
                }
              />
              <Composer
                disabled={false}
                isStreaming={false}
                onSend={(text) => {
                  void onPeerSend(text);
                }}
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
      <Statusbar />
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
        open={networkOpen}
        settings={settings}
        onClose={() => setNetworkOpen(false)}
        onSaved={onSettingsSaved}
      />
      <AddFriendDialog
        open={addFriendOpen}
        serverUrl={settings.network.server_url}
        token={settings.network.token}
        onClose={() => setAddFriendOpen(false)}
        onAdded={onAddedFriend}
      />
      <ProfileDialog
        open={profileOpen}
        initialNick={settings.profile?.nick ?? ""}
        required={profileForcedFirstRun}
        onSave={onSaveNick}
        onCancel={onCancelProfile}
      />
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
  return list.map((m) => ({
    id: m.id,
    role: m.from_me ? "user" : "assistant",
    modelId,
    text: m.body,
    timestamp: fmtPeerTime(m.created_at),
    streaming: false,
    errored: m.errored,
    e2e: m.e2e,
  }));
}

function serverMsgToPeer(m: ServerMessage, myAccountId: string | null | undefined): PeerMessage {
  return {
    id: m.id,
    from_me: !!myAccountId && m.from_id === myAccountId,
    body: m.body,
    created_at: m.created_at,
    pending: false,
  };
}

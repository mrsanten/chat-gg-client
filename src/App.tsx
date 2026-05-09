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
import * as serverApi from "./lib/serverApi";
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
          await serverApi.me(s.network.server_url, s.network.token);
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
      abortRef.current?.abort();
    };
  }, []);

  // Trzymaj refy w sync z aktualnym state'em, żeby callback z setIntervala
  // używał świeżych wartości bez wymuszania re-rejestracji.
  useEffect(() => {
    pendingUpdateRef.current = pendingUpdate;
  }, [pendingUpdate]);

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
        networkOnline={false /* phase 2B.3 podepnie WS state */}
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
          nick={settings.profile?.nick}
          onEditProfile={() => {
            setProfileForcedFirstRun(false);
            setProfileOpen(true);
          }}
        />
        <main className="gg-main">
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

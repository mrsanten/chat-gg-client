import { useEffect, useMemo, useRef, useState } from "react";
import { Titlebar } from "./components/Titlebar";
import { Menubar } from "./components/Menubar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { Statusbar } from "./components/Statusbar";
import { SettingsDialog } from "./components/Settings";
import { MODELS } from "./data/models";
import { checkConfigured, streamChat, welcomeText, ProviderError } from "./lib/providers";
import { playNotify } from "./lib/sound";
import { loadSettings } from "./lib/settings";
import { runUpdateFlow } from "./lib/updater";
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

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    })();
    // Sprawdź aktualizacje w tle przy starcie. Błędy logujemy, nie blokujemy UI.
    runUpdateFlow((status) => {
      if (status.state === "error") console.warn("[updater]", status.message);
      else console.info("[updater]", status);
    });
    return () => abortRef.current?.abort();
  }, []);

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
  };

  const onSettingsSaved = (s: Settings) => {
    setSettings(s);
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
    }

    const sid = sessionId;
    const baseMessages = messagesBySession[sid] ?? [];
    const nextMessages = [...baseMessages, userMsg, assistantMsg];
    setMessagesBySession((prev) => ({ ...prev, [sid]: nextMessages }));
    setIsStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamChat({
        model: activeModel,
        history: [...baseMessages, userMsg],
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
      <Menubar />
      <Toolbar onOpenSettings={() => setSettingsOpen(true)} />
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

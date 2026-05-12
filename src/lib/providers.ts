import { invoke, Channel } from "@tauri-apps/api/core";
import type { ChatMessage, Provider, Settings, ToolModel } from "../types";

export interface StreamOpts {
  model: ToolModel;
  history: ChatMessage[];
  signal: AbortSignal;
  onDelta: (chunk: string) => void;
  settings: Settings;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

type RustRequest =
  | { kind: "anthropic"; model: string }
  | { kind: "open_ai"; model: string }
  | { kind: "moonshot"; model: string }
  | { kind: "claude_code"; model: string }
  | { kind: "codex"; model: string };

function buildRequest(model: ToolModel, settings: Settings): RustRequest {
  if (model.provider === "anthropic") {
    if (settings.anthropic.auth.mode === "claude_code") {
      return { kind: "claude_code", model: model.apiModelId };
    }
    return { kind: "anthropic", model: model.apiModelId };
  }
  if (model.provider === "openai") {
    if (settings.openai.auth.mode === "codex") {
      // Codex CLI z ChatGPT-account auth używa swojego defaultu (gpt-5-codex
      // lub podobny). Ignorujemy apiModelId — nawet jeśli wskazuje "gpt-4o-mini"
      // (dla API path), Codex CLI by go odrzucił.
      return { kind: "codex", model: "" };
    }
    return { kind: "open_ai", model: model.apiModelId };
  }
  if (model.provider === "moonshot") {
    return { kind: "moonshot", model: model.apiModelId };
  }
  throw new ProviderError(`Provider ${model.provider} jeszcze niewspierany.`);
}

function isProviderConfigured(provider: Provider, settings: Settings): boolean {
  if (provider === "anthropic") {
    const a = settings.anthropic.auth;
    if (a.mode === "api_key") return a.api_key.trim().length > 0;
    if (a.mode === "claude_code") return true;
    return false;
  }
  if (provider === "openai") {
    const o = settings.openai.auth;
    if (o.mode === "api_key") return o.api_key.trim().length > 0;
    if (o.mode === "codex") return true;
    return false;
  }
  if (provider === "moonshot") {
    const k = settings.moonshot.auth;
    return k.mode === "api_key" && k.api_key.trim().length > 0;
  }
  return false;
}

export function checkConfigured(model: ToolModel, settings: Settings): string | null {
  const supported: Provider[] = ["anthropic", "openai", "moonshot"];
  if (!supported.includes(model.provider)) {
    return `Model ${model.name} nie jest wspierany w tej wersji apki.`;
  }
  if (!isProviderConfigured(model.provider, settings)) {
    if (model.provider === "anthropic") {
      return "Anthropic nie skonfigurowane. Otwórz Ustawienia (toolbar → Ustawienia) i podaj klucz API albo wybierz tryb subskrypcji Claude Code.";
    }
    if (model.provider === "openai") {
      return "OpenAI nie skonfigurowane. Otwórz Ustawienia i podaj klucz API albo wybierz tryb subskrypcji Codex CLI.";
    }
    return "Moonshot (Kimi) nie skonfigurowane. Otwórz Ustawienia i wklej klucz API z platform.moonshot.ai.";
  }
  return null;
}

export async function streamChat(opts: StreamOpts): Promise<void> {
  const { model, history, signal, onDelta, settings } = opts;

  const configErr = checkConfigured(model, settings);
  if (configErr) throw new ProviderError(configErr);

  const request = buildRequest(model, settings);
  const dtoHistory = history
    .filter(
      (m) =>
        m.role === "user" ||
        (m.role === "assistant" && m.text.trim().length > 0 && !m.errored),
    )
    .map((m) => ({
      role: m.role,
      content: m.text,
      images: (m.images ?? []).map((img) => ({
        mimeType: img.mimeType,
        base64: img.base64,
      })),
    }));

  const channel = new Channel<StreamEvent>();
  let resolveDone: () => void;
  let rejectDone: (e: Error) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  channel.onmessage = (evt) => {
    if (evt.type === "delta") onDelta(evt.text);
    else if (evt.type === "done") resolveDone();
    else if (evt.type === "error") rejectDone(new ProviderError(evt.message));
  };

  const onAbort = () => rejectDone(new DOMException("aborted", "AbortError"));
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort);
  }

  try {
    await Promise.race([
      finished,
      invoke("chat_stream", { request, history: dtoHistory, onEvent: channel }).catch((e) => {
        throw new ProviderError(String(e));
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function welcomeText(model: ToolModel, settings: Settings): string {
  const err = checkConfigured(model, settings);
  if (err) {
    return `[${model.name}] ${err}`;
  }
  if (model.provider === "openai") {
    return "Cześć! Jestem GPT.\nTwoje narzędzie do kodu, automatyzacji i rozwiązywania problemów.\nNapisz, co mam dla Ciebie zrobić.";
  }
  if (model.provider === "anthropic") {
    if (settings.anthropic.auth.mode === "claude_code") {
      return "Cześć! Jestem Claude (przez subskrypcję Claude Code). Mów co dziś robimy.";
    }
    return "Cześć! Jestem Claude. Jak mogę pomóc?";
  }
  if (model.provider === "moonshot") {
    return "你好! Jestem Kimi. Mów po polsku, angielsku lub chińsku, ogarnę.";
  }
  return `Cześć! Jestem ${model.name}.`;
}

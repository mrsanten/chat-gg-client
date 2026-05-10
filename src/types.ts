export type Provider = "anthropic" | "openai" | "moonshot";

export interface ToolModel {
  id: string;
  name: string;
  provider: Provider;
  apiModelId: string;
}

export interface ImageAttachment {
  mimeType: string;
  base64: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  modelId: string;
  text: string;
  timestamp: string;
  streaming?: boolean;
  errored?: boolean;
  images?: ImageAttachment[];
}

export interface ChatSession {
  id: string;
  modelId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: string;
    errored?: boolean;
    images?: ImageAttachment[];
  }>;
}

export interface SessionMeta {
  id: string;
  modelId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export type AnthropicAuth =
  | { mode: "none" }
  | { mode: "api_key"; api_key: string }
  | { mode: "claude_code"; binary_path?: string | null };

export type OpenAiAuth =
  | { mode: "none" }
  | { mode: "api_key"; api_key: string }
  | { mode: "codex"; binary_path?: string | null };

export type MoonshotAuth =
  | { mode: "none" }
  | { mode: "api_key"; api_key: string; base_url?: string | null };

export type MacroMode = "action" | "session";

export interface Macro {
  id: string;
  name: string;
  /**
   * Szablon tekstu. Dla `action`: jeśli zawiera `{input}`, placeholder
   * zostanie podmieniony aktualnym tekstem z composera; bez placeholdera
   * szablon trafi przed tekst usera (oddzielony pustą linią).
   *
   * Dla `session`: szablon jest dołączany niewidocznie do każdej wiadomości
   * wysłanej w sesji, w której makro jest włączone (jak system prompt
   * doczepiony per-message). Placeholder `{input}` jest opcjonalny.
   */
  template: string;
  /** Tryb pracy makra. Default: `action`. */
  mode?: MacroMode;
  /** [tryb action] Auto-wyślij wiadomość po podstawieniu (default: true). */
  auto_send?: boolean;
}

export interface ProfileSettings {
  nick: string;
}

export interface NetworkSettings {
  /** URL serwera GAIdu (REST + WSS). Bez trailing slasha. */
  server_url: string;
  /** JWT z `/auth/login`. Pusty string = wylogowany. */
  token: string;
  /** Cache po loginie — wyświetlanie bez czekania na /me. */
  account_id?: string | null;
  username?: string | null;
}

export interface Settings {
  anthropic: {
    auth: AnthropicAuth;
    model_id?: string | null;
  };
  openai: {
    auth: OpenAiAuth;
    model_id?: string | null;
  };
  moonshot: {
    auth: MoonshotAuth;
    model_id?: string | null;
  };
  macros: Macro[];
  profile: ProfileSettings;
  network: NetworkSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  anthropic: { auth: { mode: "none" }, model_id: null },
  openai: { auth: { mode: "none" }, model_id: null },
  moonshot: { auth: { mode: "none" }, model_id: null },
  macros: [],
  profile: { nick: "" },
  network: {
    server_url: "https://gg.jacula.cloud",
    token: "",
    account_id: null,
    username: null,
  },
};

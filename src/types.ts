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
  | { mode: "api_key"; api_key: string };

export type MoonshotAuth =
  | { mode: "none" }
  | { mode: "api_key"; api_key: string; base_url?: string | null };

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
}

export const DEFAULT_SETTINGS: Settings = {
  anthropic: { auth: { mode: "none" }, model_id: null },
  openai: { auth: { mode: "none" }, model_id: null },
  moonshot: { auth: { mode: "none" }, model_id: null },
};

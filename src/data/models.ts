import type { ToolModel } from "../types";

export const MODELS: ToolModel[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    // Dla API-key auth: gpt-4o (flagship OpenAI).
    // Dla Codex CLI auth: providers.ts override-uje na pusty string,
    // Codex użyje swojego defaultu (gpt-5-codex lub podobny).
    apiModelId: "gpt-4o",
  },
  {
    id: "gpt-3.5-turbo",
    name: "GPT 3.5 Turbo",
    provider: "openai",
    apiModelId: "gpt-3.5-turbo",
  },
  {
    id: "opus-4.7",
    name: "Opus 4.7",
    provider: "anthropic",
    apiModelId: "claude-opus-4-5",
  },
  {
    id: "kimi-2.6",
    name: "Kimi 2.6",
    provider: "moonshot",
    apiModelId: "kimi-k2.6",
  },
];

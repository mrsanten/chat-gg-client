import type { ToolModel } from "../types";

export const MODELS: ToolModel[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    // Codex CLI z ChatGPT-account auth (subskrypcja, nie API key) wspiera
    // tylko: gpt-5, gpt-5-codex, o3-mini, o3 itd. gpt-4o* są tylko API-key.
    apiModelId: "gpt-5",
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

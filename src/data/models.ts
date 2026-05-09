import type { ToolModel } from "../types";

export const MODELS: ToolModel[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    apiModelId: "gpt-4o-mini",
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

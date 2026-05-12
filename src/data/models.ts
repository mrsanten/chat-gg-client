import type { ToolModel } from "../types";

export const MODELS: ToolModel[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    // Codex CLI z ChatGPT-account auth (subskrypcja, nie API key). Apple/OAI
    // accepts tylko specjalizowane modele: gpt-5-codex (default), o4-mini.
    // Generalne gpt-5/gpt-4o* są tylko przez API-key auth. Pusty string =
    // pomiń --model flag-ę, niech Codex CLI sam wybierze swój default.
    apiModelId: "",
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

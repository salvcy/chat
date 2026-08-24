/** Shared types + constants (no server-only imports — safe client-side). */

/** Hardcoded fallback — the live catalog switcher is Phase 2. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

/** Trimmed OpenRouter catalog entry served by /api/models. */
export type OpenRouterModel = {
  id: string;
  name: string;
  /** Max context tokens, if reported. */
  contextLength: number | null;
  /** USD per prompt token (string, as reported by OpenRouter). */
  promptPrice: string | null;
  /** USD per completion token (string, as reported by OpenRouter). */
  completionPrice: string | null;
};

/** Reasoning control — maps directly to OpenRouter's `reasoning.effort`. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
];

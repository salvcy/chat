import {
  DEFAULT_MODEL,
  EFFORT_ORDER,
  type ChatSettings,
  type ModelCapabilities,
  type OpenRouterModel,
  type ReasoningEffort,
} from "./types";

/**
 * Capability resolution, client-side.
 *
 * The rule this file enforces: a control is only offered when the selected
 * model will actually honour it. Everything reads from the catalog rather
 * than from a hardcoded list of "models that can think", so a model added to
 * OpenRouter tomorrow gets correct controls with no code change.
 */

/** What we assume before the catalog loads: allow everything, block nothing. */
const OPTIMISTIC: ModelCapabilities = {
  vision: false,
  imageGeneration: false,
  tools: true,
  reasoning: true,
  reasoningMandatory: false,
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
};

export function capabilitiesFor(
  modelId: string,
  models: OpenRouterModel[],
): ModelCapabilities {
  return models.find((m) => m.id === modelId)?.capabilities ?? OPTIMISTIC;
}

export function modelFor(
  modelId: string,
  models: OpenRouterModel[],
): OpenRouterModel | undefined {
  return models.find((m) => m.id === modelId);
}

/** The reasoning menu for a model: "off" plus exactly its advertised efforts. */
export function effortOptions(caps: ModelCapabilities): ReasoningEffort[] {
  if (!caps.reasoning) return [];
  const efforts = [...caps.efforts].sort(
    (a, b) => EFFORT_ORDER[a] - EFFORT_ORDER[b],
  );
  // A mandatory-reasoning model has no "off" — offering one would send a
  // request the provider silently overrides.
  return caps.reasoningMandatory ? efforts : ["off", ...efforts];
}

/** Why a control is unavailable, for the tooltip. Null when it's available. */
export function unavailableReason(
  control: "search" | "reasoning" | "attach",
  caps: ModelCapabilities,
): string | null {
  switch (control) {
    case "search":
      return caps.tools ? null : "this model does not accept tools";
    case "reasoning":
      return caps.reasoning ? null : "this model has no reasoning mode";
    case "attach":
      return caps.vision ? null : "this model does not accept images";
  }
}

/**
 * Coerce settings to something the target model can actually serve. Called
 * on every model switch so a thread carried from a thinking model to one
 * without reasoning doesn't keep sending a parameter that gets dropped.
 */
export function reconcileSettings(
  settings: ChatSettings,
  models: OpenRouterModel[],
): ChatSettings {
  // Catalog ids are authoritative. A model can be renamed or removed while a
  // conversation still points at it; transparently tune that stale thread to
  // the default (or the first live entry) instead of sending a malformed or
  // unavailable slug upstream.
  const model = models.some((entry) => entry.id === settings.model)
    ? settings.model
    : models.some((entry) => entry.id === DEFAULT_MODEL)
      ? DEFAULT_MODEL
      : (models[0]?.id ?? settings.model);
  const caps = capabilitiesFor(model, models);
  const allowed = effortOptions(caps);

  let reasoning = settings.reasoning;
  if (!caps.reasoning) {
    reasoning = "off";
  } else if (!allowed.includes(reasoning)) {
    // Prefer the model's own default, then the middle of what it offers.
    reasoning =
      (caps.reasoningMandatory && reasoning === "off"
        ? (caps.defaultEffort ?? allowed[0])
        : undefined) ??
      (settings.reasoning === "off"
        ? "off"
        : (caps.defaultEffort ?? allowed[Math.floor(allowed.length / 2)]));
    if (!allowed.includes(reasoning)) reasoning = allowed[0] ?? "off";
  }

  return {
    ...settings,
    model,
    reasoning,
    search: caps.tools ? settings.search : false,
  };
}

/** Short display form: "claude-sonnet-4.6" from "anthropic/claude-sonnet-4.6". */
export function shortModelId(id: string): string {
  return id.split("/")[1] ?? id;
}

export { DEFAULT_MODEL };

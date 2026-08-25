import "server-only";

import {
  EFFORT_ORDER,
  type ModelCapabilities,
  type OpenRouterModel,
  type ReasoningEffort,
} from "./types";

/**
 * Server-side model catalog. OpenRouter's `/models` is the single source of
 * truth for what each model can do — this module normalizes it once and
 * everything else (the /api/models route, request validation) reads from
 * here rather than re-deriving capability rules.
 */

/** The raw shape we care about. OpenRouter sends considerably more. */
type RawModel = {
  id: string;
  name?: string;
  description?: string | null;
  created?: number | null;
  context_length?: number | null;
  knowledge_cutoff?: string | null;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  } | null;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  } | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    web_search?: string;
    input_cache_read?: string;
  } | null;
  supported_parameters?: string[] | null;
  reasoning?: {
    mandatory?: boolean;
    supported_efforts?: string[] | null;
    default_effort?: string | null;
  } | null;
};

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

/** Cache the upstream catalog for an hour — it changes on the order of days. */
const REVALIDATE_SECONDS = 3600;

function isEffort(v: string): v is ReasoningEffort {
  return v in EFFORT_ORDER;
}

/** First sentence of the description, capped — enough to disambiguate. */
function blurbOf(description: string | null | undefined): string | null {
  if (!description) return null;
  const cleaned = description
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // strip markdown links
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const stop = cleaned.indexOf(". ");
  const sentence = stop > 40 ? cleaned.slice(0, stop + 1) : cleaned;
  return sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence;
}

/**
 * Derive what the UI is allowed to offer. Anything not positively advertised
 * is treated as unsupported — a control that silently no-ops is worse than
 * one that isn't there.
 */
function capabilitiesOf(m: RawModel): ModelCapabilities {
  const params = new Set(m.supported_parameters ?? []);
  const inputs = new Set(m.architecture?.input_modalities ?? []);
  const outputs = new Set(m.architecture?.output_modalities ?? []);

  const reasoning =
    params.has("reasoning") ||
    params.has("reasoning_effort") ||
    params.has("include_reasoning") ||
    m.reasoning != null;

  const advertised = (m.reasoning?.supported_efforts ?? [])
    .filter(isEffort)
    .filter((e) => e !== "off");

  // Models that accept `reasoning` but don't enumerate efforts get the
  // conventional three rather than an empty menu.
  const efforts: ReasoningEffort[] =
    advertised.length > 0
      ? [...advertised].sort((a, b) => EFFORT_ORDER[a] - EFFORT_ORDER[b])
      : reasoning
        ? ["low", "medium", "high"]
        : [];

  const rawDefault = m.reasoning?.default_effort;

  return {
    vision: inputs.has("image"),
    imageGeneration: outputs.has("image"),
    tools: params.has("tools"),
    reasoning,
    reasoningMandatory: m.reasoning?.mandatory === true,
    efforts,
    defaultEffort:
      rawDefault && isEffort(rawDefault) ? rawDefault : (efforts[1] ?? null),
  };
}

function normalize(m: RawModel): OpenRouterModel {
  const price = m.pricing ?? {};
  return {
    id: m.id,
    name: m.name ?? m.id,
    vendor: m.id.split("/")[0] ?? "other",
    blurb: blurbOf(m.description),
    contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
    maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
    promptPrice: price.prompt ?? null,
    completionPrice: price.completion ?? null,
    cacheReadPrice: price.input_cache_read ?? null,
    webSearchPrice: price.web_search ?? null,
    created: m.created ?? null,
    knowledgeCutoff: m.knowledge_cutoff ?? null,
    capabilities: capabilitiesOf(m),
  };
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/**
 * Fetch + normalize the catalog. Relies on Next's fetch cache for the hourly
 * revalidate, so concurrent callers within a request share one upstream hit.
 */
export async function fetchCatalog(): Promise<OpenRouterModel[]> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new CatalogError(
      "OPENROUTER_API_KEY is not set — add it to .env.local",
      500,
    );
  }

  const res = await fetch(CATALOG_URL, {
    headers: { Authorization: `Bearer ${key}` },
    next: { revalidate: REVALIDATE_SECONDS },
  });

  if (!res.ok) {
    throw new CatalogError(
      `OpenRouter catalog returned ${res.status}`,
      res.status === 401 ? 401 : 502,
    );
  }

  const { data } = (await res.json()) as { data: RawModel[] };
  return data
    .filter((m) => typeof m.id === "string")
    .map(normalize)
    .sort((a, b) => a.id.localeCompare(b.id));
}

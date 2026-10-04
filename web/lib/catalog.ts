"use client";

import {
  EFFORT_ORDER,
  type ModelCapabilities,
  type OpenRouterModel,
  type ReasoningEffort,
} from "./types";

/**
 * The model catalog, fetched by the browser.
 *
 * OpenRouter's `/models` is the single source of truth for what each model
 * can do, and it is a *public* endpoint — no key, and `Access-Control-Allow-
 * Origin: *`. So the catalog loads before a key is connected, which is what
 * lets the model list render behind the connect screen instead of after it.
 *
 * This module used to be server-only and sat behind `/api/models`, using
 * Next's fetch cache for its hourly revalidate. The normalization is
 * unchanged; only the cache moved (see `readCache`).
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

/**
 * The Cache API, not `localStorage`.
 *
 * This is ~220KB of public data from openrouter.ai — an HTTP response with a
 * time-to-live, which is precisely what the Cache API is for and precisely
 * what `localStorage` is not. The old version serialised the parsed catalog
 * back to a JSON string and wrote it synchronously on the main thread; this
 * stores the response itself, asynchronously, off the critical path.
 *
 * It is also the reason stripping local storage did not cost a fetch on
 * every load. Nothing here is the user's: no key, no ids, no history.
 */
const CACHE_NAME = "dial-catalog-v1";
const CACHE_REQUEST = "https://dial.local/catalog";
const FETCHED_AT_HEADER = "x-dial-fetched-at";

/** Cache the catalog for an hour — it changes on the order of days. */
const MAX_AGE_MS = 60 * 60 * 1000;

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
    documents: inputs.has("file"),
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

/* -------------------------------- cache -------------------------------- */

type CacheEntry = { fetchedAt: number; models: OpenRouterModel[] };

/** Session-lifetime copy, so a remount never re-reads or re-parses. */
let memory: CacheEntry | null = null;

function cacheAvailable(): boolean {
  // Absent in non-secure contexts and in some private modes. The memory copy
  // above still works, so this only costs one fetch per load.
  return typeof caches !== "undefined";
}

async function readCache(): Promise<CacheEntry | null> {
  if (memory) return memory;
  if (!cacheAvailable()) return null;
  try {
    const store = await caches.open(CACHE_NAME);
    const hit = await store.match(CACHE_REQUEST);
    if (!hit) return null;
    const fetchedAt = Number(hit.headers.get(FETCHED_AT_HEADER));
    if (!Number.isFinite(fetchedAt)) return null;
    const models = (await hit.json()) as OpenRouterModel[];
    if (!Array.isArray(models) || models.length === 0) return null;
    memory = { fetchedAt, models };
    return memory;
  } catch {
    return null;
  }
}

async function writeCache(entry: CacheEntry): Promise<void> {
  memory = entry;
  if (!cacheAvailable()) return;
  try {
    const store = await caches.open(CACHE_NAME);
    await store.put(
      CACHE_REQUEST,
      new Response(JSON.stringify(entry.models), {
        headers: {
          "Content-Type": "application/json",
          [FETCHED_AT_HEADER]: String(entry.fetchedAt),
        },
      }),
    );
  } catch {
    // Quota or private mode — the session cache above still holds.
  }
}

/* -------------------------------- fetch -------------------------------- */

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

async function fetchFresh(signal?: AbortSignal): Promise<OpenRouterModel[]> {
  const res = await fetch(CATALOG_URL, { signal });
  if (!res.ok) {
    throw new CatalogError(
      `OpenRouter catalog returned ${res.status}`,
      res.status,
    );
  }
  const { data } = (await res.json()) as { data: RawModel[] };
  return data
    .filter((m) => typeof m.id === "string")
    .map(normalize)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The catalog, cached for an hour.
 *
 * A stale cache is preferred over a failed load: if the network is down but
 * we have yesterday's copy, the switcher still works and the capability
 * controls are still correct for all but the newest models.
 */
export async function fetchCatalog(
  signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
  const cached = await readCache();
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) {
    return cached.models;
  }

  try {
    const models = await fetchFresh(signal);
    void writeCache({ fetchedAt: Date.now(), models });
    return models;
  } catch (error) {
    if (cached) return cached.models;
    throw error;
  }
}

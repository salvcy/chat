/** Shared types + constants (no server-only imports — safe client-side). */

/** Fallback when nothing is selected or a persisted id fails validation. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * provider/slug, optionally with a :variant — e.g. `anthropic/claude-sonnet-4.6`
 * or `mistralai/mistral-7b-instruct:free`.
 *
 * The leading `~` is not a typo: OpenRouter publishes floating aliases that
 * always resolve to a provider's newest release (`~anthropic/claude-sonnet-latest`).
 * They're ordinary selectable catalog entries, so rejecting them here made the
 * switcher offer twelve models the route would then 400 on.
 */
export const MODEL_ID_PATTERN = /^~?[\w.-]+\/[\w:.-]{1,120}$/;

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

/**
 * OpenRouter's full reasoning-effort scale. The four-value version this app
 * shipped with was a subset — models advertise which of these they accept
 * via `reasoning.supported_efforts`, so the composer offers exactly those.
 */
export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Order used when narrowing a model's advertised efforts to a menu. */
export const EFFORT_ORDER: Record<ReasoningEffort, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
};

/**
 * A catalog entry, normalized from OpenRouter's `/models`. This is the
 * capability surface the UI reads to decide which controls are even
 * offerable — a control the model can't honour is never shown live.
 */
export type OpenRouterModel = {
  id: string;
  name: string;
  /** Vendor prefix — "anthropic", "openai", … Used for grouping. */
  vendor: string;
  /** One-line trim of OpenRouter's description. */
  blurb: string | null;
  /** Max context tokens, if reported. */
  contextLength: number | null;
  /** Cap on a single response, if the top provider reports one. */
  maxCompletionTokens: number | null;
  /** USD per token, as reported (strings — they're tiny decimals). */
  promptPrice: string | null;
  completionPrice: string | null;
  /** USD per cached prompt token, when the model supports cache reads. */
  cacheReadPrice: string | null;
  /** USD per web_search call, when the model supports the tool. */
  webSearchPrice: string | null;
  /** Unix seconds the model was added to OpenRouter. */
  created: number | null;
  /** ISO date string, when the model reports one. */
  knowledgeCutoff: string | null;
  capabilities: ModelCapabilities;
};

export type ModelCapabilities = {
  /** Accepts image input — gates the attach control. */
  vision: boolean;
  /**
   * Accepts a raw file (PDF) as input, natively.
   *
   * False does not mean PDFs are unavailable: OpenRouter's file-parser
   * plugin converts a document to markdown for any model. It decides which
   * engine to ask for — see `pdfEngineFor`.
   */
  documents: boolean;
  /** Produces image output — allows @image to use the selected model. */
  imageGeneration: boolean;
  /** Accepts a `tools` array — gates web search. */
  tools: boolean;
  /** Accepts `reasoning` / `reasoning_effort`. */
  reasoning: boolean;
  /** Reasoning cannot be turned off for this model (e.g. o-series). */
  reasoningMandatory: boolean;
  /** Exactly the efforts this model accepts, low→high. Empty when unknown. */
  efforts: ReasoningEffort[];
  /** The effort OpenRouter applies when we don't specify one. */
  defaultEffort: ReasoningEffort | null;
};

/* ------------------------------------------------------------------ */
/* Image generation                                                    */
/* ------------------------------------------------------------------ */

/** OpenRouter's documented default for its image-generation tool/API. */
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

/**
 * Names a thread in five words, so it should be the cheapest capable model
 * rather than the one the conversation is using. Failure is non-fatal: the
 * locally derived title stays.
 */
export const DEFAULT_TITLE_MODEL = "google/gemini-2.5-flash-lite";

export type GeneratedImageAsset = {
  /** Embedded locally so the image survives a reload without a CDN. */
  url: string;
  mediaType: string;
  /** Opaque R2 object id. Present after the first account sync. */
  blobId?: string;
  /** Optional direct R2 custom-domain URL; the bytes there are ciphertext. */
  blobUrl?: string;
};

/**
 * A locally executed image-generation run, stored as a UI data part.
 * Data parts are deliberately omitted from later text-model requests, keeping
 * multi-megabyte image payloads in IndexedDB instead of every chat POST.
 */
export type GeneratedImageData = {
  status: "generating" | "complete" | "error";
  prompt: string;
  model: string;
  images: GeneratedImageAsset[];
  startedAt: number;
  durationMs: number | null;
  costUsd: number | null;
  error: string | null;
};

export type RequestStatusData = {
  kind: "interrupted" | "empty";
  at: number;
};

export type DialDataParts = {
  image: GeneratedImageData;
  requestStatus: RequestStatusData;
};

/* ------------------------------------------------------------------ */
/* Message telemetry                                                   */
/* ------------------------------------------------------------------ */

/**
 * The flight recorder attached to every assistant message. Streamed down
 * as UIMessage metadata (start → finish-step → finish) and persisted with
 * the message, so a reopened conversation still shows what each answer
 * actually cost and how fast it arrived.
 *
 * Everything here is *measured*, which is why it renders in mono.
 */
export type DialMetadata = {
  /** Model id the request was sent as. */
  model?: string;
  /** The provider OpenRouter actually routed to (Fireworks, Together, …). */
  provider?: string;
  /** Wall-clock ms the request started, client-displayable as a timestamp. */
  startedAt?: number;
  /** ms from request start to the first text or reasoning delta. */
  ttftMs?: number;
  /**
   * ms spent thinking — first reasoning token to last. Measured at the
   * boundary rather than inferred from the total, so a slow provider queue
   * doesn't get counted as thinking.
   */
  thinkingMs?: number;
  /**
   * When each reasoning part ran, keyed by the part's id: `[start, end]` in
   * ms from `startedAt` (`end` is missing while it is still running). This is
   * what lets the activity timeline say how long each step took rather than
   * one total for the turn.
   */
  timings?: Record<string, number[]>;
  /** ms from request start to the finish event. */
  durationMs?: number;
  /** Completion tokens ÷ generation seconds. */
  tokensPerSecond?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Subset of promptTokens served from the provider's cache. */
  cachedTokens?: number;
  /** Subset of completionTokens spent on the reasoning trace. */
  reasoningTokens?: number;
  /** Real USD charged, from OpenRouter usage accounting — not an estimate. */
  costUsd?: number;
  /** Why generation stopped: "stop" | "length" | "tool-calls" | … */
  finishReason?: string;
  /**
   * The model delivered its answer on the reasoning channel and nothing on
   * the content channel, so the trace was promoted to the answer. Recorded
   * so the flight recorder can say so rather than pretend it streamed text.
   */
  answerInReasoning?: boolean;
  /** Reasoning effort the request was sent with, for provenance. */
  effort?: ReasoningEffort;
  /** Whether web search was offered to the model for this turn. */
  search?: boolean;
};

/* ------------------------------------------------------------------ */
/* Chat request                                                        */
/* ------------------------------------------------------------------ */

/**
 * Per-conversation knobs, sent with every turn and persisted per thread.
 *
 * The system prompt is not one of them any more: it is the account's
 * instructions (`UserSettings.instructions`), the same in every conversation.
 */
export type ChatSettings = {
  model: string;
  reasoning: ReasoningEffort;
  /**
   * Derived, never chosen: on whenever the model can call the web-search
   * tool (`reconcileSettings`). The model decides when a turn needs it.
   */
  search: boolean;
  /** 0–2. Undefined leaves the provider default alone. */
  temperature?: number;
};

export const DEFAULT_SETTINGS: ChatSettings = {
  model: DEFAULT_MODEL,
  reasoning: "off",
  search: false,
};

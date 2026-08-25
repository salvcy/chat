import {
  convertToModelMessages,
  safeValidateUIMessages,
  streamText,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { OpenRouterProviderOptions } from "@openrouter/ai-sdk-provider";
import { openrouter } from "@/lib/openrouter";
import { CatalogError, fetchCatalog } from "@/lib/catalog";
import {
  chatRequestSchema,
  dialMetadataSchema,
  generatedImageDataSchema,
  requestStatusDataSchema,
} from "@/lib/schema";
import {
  DEFAULT_MODEL,
  type DialDataParts,
  type DialMetadata,
  type ReasoningEffort,
} from "@/lib/types";

/**
 * POST /api/chat — the streaming proxy.
 *
 * Beyond forwarding the turn it acts as the app's instrument bus: every
 * assistant message comes back carrying a `DialMetadata` flight recorder
 * (routed provider, time-to-first-token, tok/s, token split, real USD cost)
 * assembled from OpenRouter's usage accounting. Nothing here is estimated
 * client-side — the numbers the UI renders in mono are measured numbers.
 *
 * The OpenRouter key is server-only and never crosses to the client.
 */

/** Streaming responses must not be statically optimized. */
export const dynamic = "force-dynamic";

const MAX_CHAT_BODY_BYTES = 24 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 4;

/** OpenRouter's usage-accounting block, as attached to provider metadata. */
type UsageAccounting = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  promptTokensDetails?: { cachedTokens?: number };
  completionTokensDetails?: { reasoningTokens?: number };
};

/** Client-sent system messages are dropped — the prompt is set server-side. */
function withoutSystem(
  messages: UIMessage<DialMetadata, DialDataParts>[],
): UIMessage<DialMetadata, DialDataParts>[] {
  return messages.filter((m) => m.role !== "system");
}

function jsonError(message: string, status = 400) {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Approximate decoded bytes in a base64 data URL without allocating them. */
function dataUrlBytes(url: string): number | null {
  const comma = url.indexOf(",");
  if (comma < 0 || !url.slice(0, comma).includes(";base64")) return null;
  const encoded = url.length - comma - 1;
  return Math.floor((encoded * 3) / 4);
}

function validateImages(
  messages: UIMessage<DialMetadata, DialDataParts>[],
): string | null {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages.at(-1);
  const latestImages = latest?.parts.filter((part) => part.type === "file") ?? [];
  if (latestImages.length > MAX_IMAGES_PER_TURN) {
    return `attach up to ${MAX_IMAGES_PER_TURN} images per turn`;
  }

  for (const message of userMessages) {
    for (const part of message.parts) {
      if (part.type !== "file") continue;
      if (!part.mediaType.startsWith("image/")) {
        return "only image attachments are supported";
      }
      if (!part.url.startsWith("data:image/")) {
        return "image attachments must be embedded data URLs";
      }
      const bytes = dataUrlBytes(part.url);
      if (bytes === null) return "image attachment was not valid base64 data";
      if (bytes > MAX_EMBEDDED_IMAGE_BYTES) {
        return "each image must be smaller than 8 MB";
      }
    }
  }

  // Per-turn combined cap. Historical images are still bounded by the whole
  // request limit above, but should not permanently prevent later turns from
  // attaching another small image.
  const latestBytes = latestImages.reduce((sum, part) => {
    const bytes = dataUrlBytes(part.url);
    return sum + (bytes ?? 0);
  }, 0);
  return latestBytes > MAX_TOTAL_IMAGE_BYTES
    ? "keep combined images under 16 MB per turn"
    : null;
}

export async function POST(req: Request) {
  const declaredSize = Number(req.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_CHAT_BODY_BYTES) {
    return jsonError("request body is too large", 413);
  }

  let raw: unknown;
  try {
    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > MAX_CHAT_BODY_BYTES) {
      return jsonError("request body is too large", 413);
    }
    raw = JSON.parse(body);
  } catch {
    return jsonError("request body was not valid JSON");
  }

  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return jsonError(
      `${first.path.join(".") || "body"}: ${first.message.toLowerCase()}`,
    );
  }

  const {
    messages,
    model = DEFAULT_MODEL,
    reasoning = "off",
    search = false,
    system,
    temperature,
  } = parsed.data;

  const validated = await safeValidateUIMessages<
    UIMessage<DialMetadata, DialDataParts>
  >({
    messages,
    // Metadata is attached to assistant turns only. User messages naturally
    // carry `undefined`, so the schema itself must be optional here.
    metadataSchema: dialMetadataSchema.optional(),
    dataSchemas: {
      image: generatedImageDataSchema,
      requestStatus: requestStatusDataSchema,
    },
  });
  if (!validated.success) {
    return jsonError(
      "messages: expected valid chat messages with id, role, and parts",
    );
  }
  const uiMessages = withoutSystem(validated.data);

  const imageError = validateImages(uiMessages);
  if (imageError) return jsonError(`attachments: ${imageError}`);

  let effectiveReasoning: ReasoningEffort = reasoning;
  try {
    const catalog = await fetchCatalog();
    const selected = catalog.find((entry) => entry.id === model);
    if (!selected) {
      return jsonError("model is no longer available in the OpenRouter catalog");
    }
    const { capabilities } = selected;
    if (search && !capabilities.tools) {
      return jsonError("selected model does not support web search tools");
    }
    if (reasoning !== "off") {
      if (!capabilities.reasoning) {
        return jsonError("selected model does not support reasoning");
      }
      if (!capabilities.efforts.includes(reasoning)) {
        return jsonError(
          `selected model does not support ${reasoning} reasoning effort`,
        );
      }
    } else if (capabilities.reasoningMandatory) {
      effectiveReasoning =
        capabilities.defaultEffort ?? capabilities.efforts[0] ?? "medium";
    }
  } catch (error) {
    const status = error instanceof CatalogError ? error.status : 502;
    return jsonError(
      error instanceof Error ? error.message : "model catalog unavailable",
      status,
    );
  }

  let modelMessages: ModelMessage[];
  try {
    modelMessages = await convertToModelMessages(uiMessages);
  } catch (error) {
    return jsonError(
      error instanceof Error
        ? `messages could not be converted: ${error.message}`
        : "messages could not be converted",
    );
  }

  // Reasoning maps to OpenRouter's unified param and streams back as
  // distinct `reasoning` parts — never parsed out of the answer text.
  const openrouterOpts: OpenRouterProviderOptions =
    effectiveReasoning === "off"
      ? {}
      : { reasoning: { enabled: true, effort: effectiveReasoning } };

  const startedAt = Date.now();
  let firstDeltaAt: number | null = null;
  let generationStartedAt: number | null = null;
  // The reasoning→answer boundary, for the "thought for N" readout.
  let reasoningFirstAt: number | null = null;
  let textFirstAt: number | null = null;

  const result = streamText({
    // `usage.include` turns on OpenRouter usage accounting, which is what
    // makes the real per-message cost available instead of an estimate.
    model: openrouter(model, { usage: { include: true } }),
    messages: modelMessages,
    ...(system?.trim() ? { system: system.trim() } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    // web_search is provider-executed: the model decides when to call it and
    // results come back as `source-url` parts, not tool output we handle.
    ...(search ? { tools: { web_search: openrouter.tools.webSearch({}) } } : {}),
    providerOptions: { openrouter: openrouterOpts },
    // Propagate client disconnects so an abandoned stream stops billing.
    abortSignal: req.signal,
  });

  /**
   * Metadata is emitted incrementally and merged on the client, so each
   * hook contributes only the facts it can actually observe:
   *   start       → what we asked for
   *   first delta → time to first token
   *   finish-step → provider + usage accounting (the real cost)
   *   finish      → duration, throughput, stop reason
   */
  const messageMetadata = ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }): DialMetadata | undefined => {
    switch (part.type) {
      case "start":
        return {
          model,
          startedAt,
          effort: effectiveReasoning,
          search,
        };

      case "reasoning-delta": {
        const now = Date.now();
        if (reasoningFirstAt === null) reasoningFirstAt = now;
        if (firstDeltaAt !== null) return undefined;
        firstDeltaAt = now;
        generationStartedAt = now;
        return { ttftMs: now - startedAt };
      }

      case "text-delta": {
        const now = Date.now();
        const meta: DialMetadata = {};
        if (textFirstAt === null) {
          textFirstAt = now;
          // Thinking ends the moment the answer starts.
          if (reasoningFirstAt !== null) {
            meta.thinkingMs = now - reasoningFirstAt;
          }
        }
        if (firstDeltaAt === null) {
          firstDeltaAt = now;
          generationStartedAt = now;
          meta.ttftMs = now - startedAt;
        }
        return Object.keys(meta).length > 0 ? meta : undefined;
      }

      case "finish-step": {
        const usage = (
          part.providerMetadata?.openrouter as
            | { provider?: string; usage?: UsageAccounting }
            | undefined
        )?.usage;
        const provider = (
          part.providerMetadata?.openrouter as
            | { provider?: string }
            | undefined
        )?.provider;

        const meta: DialMetadata = {};
        if (provider) meta.provider = provider;
        if (usage?.cost !== undefined) meta.costUsd = usage.cost;
        if (usage?.promptTokensDetails?.cachedTokens !== undefined) {
          meta.cachedTokens = usage.promptTokensDetails.cachedTokens;
        }
        if (usage?.completionTokensDetails?.reasoningTokens !== undefined) {
          meta.reasoningTokens = usage.completionTokensDetails.reasoningTokens;
        }
        return Object.keys(meta).length > 0 ? meta : undefined;
      }

      case "finish": {
        const endedAt = Date.now();
        // Reasoned but never answered (length cap, tool-only step): close the
        // thinking window at the end rather than reporting nothing.
        const thinkingMs =
          reasoningFirstAt !== null && textFirstAt === null
            ? endedAt - reasoningFirstAt
            : undefined;
        const completionTokens = part.totalUsage.outputTokens;
        // Measure throughput over generation only — including the wait for
        // the first token would understate a fast model behind a slow queue.
        const genMs = endedAt - (generationStartedAt ?? startedAt);
        return {
          durationMs: endedAt - startedAt,
          finishReason: part.finishReason,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
          promptTokens: part.totalUsage.inputTokens,
          completionTokens,
          ...(completionTokens && genMs > 0
            ? {
                tokensPerSecond:
                  Math.round((completionTokens / (genMs / 1000)) * 10) / 10,
              }
            : {}),
        };
      }

      default:
        return undefined;
    }
  };

  return result.toUIMessageStreamResponse<
    UIMessage<DialMetadata, DialDataParts>
  >({
    headers: { "Cache-Control": "no-store" },
    sendSources: true,
    sendReasoning: true,
    messageMetadata,
    // Surface the upstream reason in-stream (a bare 200 with no body left
    // the client unable to explain e.g. a data-policy-restricted model).
    onError: (err) => (err instanceof Error ? err.message : "an error occurred"),
  });
}

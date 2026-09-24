"use client";

import {
  convertToModelMessages,
  streamText,
  toUIMessageStream,
  type ChatTransport,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { OpenRouterProviderOptions } from "@openrouter/ai-sdk-provider";
import { currentKey } from "./credentials";
import { MissingKeyError, providerFor } from "./openrouter-client";
import { messagesForTextModel } from "./messages";
import { reviveLateReasoning } from "./reasoning-stream";
import type {
  ChatSettings,
  DialDataParts,
  DialMetadata,
  ModelCapabilities,
} from "./types";
import { pdfEngineFor } from "./capabilities";

type DialMessage = UIMessage<DialMetadata, DialDataParts>;

/**
 * The chat transport — `streamText` running in the browser.
 *
 * This is the file that used to be `app/api/chat/route.ts`. It does the same
 * work in the same order; the difference is where it runs. A server in this
 * path is billed for the wall-clock duration of every stream while doing
 * essentially no work, so a long reasoning answer was pure cost and a hard
 * timeout. Here there is no server, no timeout, and no bill.
 *
 * What is deliberately *not* carried over from the route:
 *
 *  - Request validation. The route re-validated because a client could lie;
 *    this code *is* the client, and `reconcileSettings` has already coerced
 *    the knobs to what the selected model advertises.
 *  - Payload size caps. They existed to protect our function's memory. The
 *    browser now spends its own memory talking to OpenRouter directly.
 *  - The server-held system prompt. It is the user's own prompt on their own
 *    key; there is nothing here to hide from them.
 *
 * What is carried over exactly: the flight recorder. Every number the UI
 * renders in mono is still measured rather than estimated, and
 * `usage: { include: true }` is still what makes the cost real USD from
 * OpenRouter's accounting instead of a guess from token counts.
 */

/** OpenRouter's usage-accounting block, as attached to provider metadata. */
type UsageAccounting = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  promptTokensDetails?: { cachedTokens?: number };
  completionTokensDetails?: { reasoningTokens?: number };
};

/**
 * OpenRouter reports failures as `{"error":{"message":"…"}}` in the response
 * body, but the SDK's own error message for a non-2xx is generic. Prefer the
 * upstream text when it's there — "insufficient credits" is actionable and
 * "Failed after 3 attempts" is not.
 */
function describeStreamError(error: unknown): string {
  const body = (error as { responseBody?: unknown } | null)?.responseBody;
  if (typeof body === "string" && body) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string } | string;
      };
      const detail =
        typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      if (detail) return detail;
    } catch {
      // Not JSON — fall through to the SDK's message.
    }
  }
  return error instanceof Error ? error.message : "an error occurred";
}

export class OpenRouterChatTransport implements ChatTransport<DialMessage> {
  /**
   * Settings arrive as a ref rather than a value because the transport is
   * built once per conversation while the model can change mid-thread — a
   * captured copy would send the previous model on the turn right after a
   * switch. Taking the ref object (rather than a closure that reads it)
   * also keeps `.current` out of the render path entirely.
   */
  constructor(
    private readonly settings: { readonly current: ChatSettings },
    /**
     * The selected model's capabilities, by ref for the same reason as
     * settings — they change with the model, mid-thread. Only the PDF engine
     * reads them; everything else the transport sends is a per-thread knob.
     */
    private readonly capabilities: { readonly current: ModelCapabilities },
  ) {}

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<
    ChatTransport<DialMessage>["sendMessages"]
  >[0]): Promise<ReadableStream<UIMessageChunk>> {
    // Read at call time: a key captured earlier survives a disconnect.
    const key = currentKey();
    if (!key) throw new MissingKeyError();

    const { model, reasoning, search, system, temperature } =
      this.settings.current;

    const modelMessages = await convertToModelMessages(
      messagesForTextModel(messages),
    );

    // Reasoning maps to OpenRouter's unified param and streams back as
    // distinct `reasoning` parts — never parsed out of the answer text.
    const openrouterOpts: OpenRouterProviderOptions =
      reasoning === "off"
        ? {}
        : { reasoning: { enabled: true, effort: reasoning } };

    /*
     * PDFs.
     *
     * OpenRouter accepts a document as an ordinary file part and handles the
     * reading itself, so there is no parser in this codebase and none of this
     * touches our own infrastructure — the request still goes from the tab to
     * openrouter.ai against the user's key.
     *
     * The engine is always stated rather than left to default. OpenRouter's
     * own default is `mistral-ocr` at $2 per 1,000 pages; sending a document
     * should not quietly bill someone for OCR they did not ask for.
     */
    const hasPdf = modelMessages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "file" && part.mediaType === "application/pdf",
        ),
    );
    const pdfPlugin = hasPdf
      ? {
          plugins: [
            {
              id: "file-parser" as const,
              pdf: { engine: pdfEngineFor(this.capabilities.current) },
            },
          ],
        }
      : {};

    const openrouter = providerFor(key);

    const startedAt = Date.now();
    let firstDeltaAt: number | null = null;
    let generationStartedAt: number | null = null;
    // The reasoning→answer boundary, for the "thought for N" readout.
    let reasoningFirstAt: number | null = null;
    let reasoningLastAt: number | null = null;
    let textFirstAt: number | null = null;

    const result = streamText({
      // `usage.include` turns on OpenRouter usage accounting, which is what
      // makes the real per-message cost available instead of an estimate.
      model: openrouter(model, { usage: { include: true }, ...pdfPlugin }),
      messages: modelMessages,
      ...(system?.trim() ? { system: system.trim() } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      // web_search is provider-executed: the model decides when to call it and
      // results come back as `source-url` parts, not tool output we handle.
      ...(search
        ? { tools: { web_search: openrouter.tools.webSearch({}) } }
        : {}),
      providerOptions: { openrouter: openrouterOpts },
      abortSignal,
      // Needed by reviveLateReasoning; raw parts are consumed there and never
      // reach the UI stream.
      includeRawChunks: true,
    });

    /**
     * Metadata is emitted incrementally and merged by useChat, so each hook
     * contributes only the facts it can actually observe:
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
          return { model, startedAt, effort: reasoning, search };

        case "reasoning-delta": {
          const now = Date.now();
          if (reasoningFirstAt === null) reasoningFirstAt = now;
          reasoningLastAt = now;
          if (firstDeltaAt !== null) return undefined;
          firstDeltaAt = now;
          generationStartedAt = now;
          return { ttftMs: now - startedAt };
        }

        case "text-delta": {
          const now = Date.now();
          const meta: DialMetadata = {};
          // Whitespace is not the answer starting: a model can emit a bare
          // newline mid-thought and go on reasoning for a long time.
          if (textFirstAt === null && part.text.trim()) {
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
          const openrouterMeta = part.providerMetadata?.openrouter as
            | { provider?: string; usage?: UsageAccounting }
            | undefined;
          const usage = openrouterMeta?.usage;

          const meta: DialMetadata = {};
          if (openrouterMeta?.provider) meta.provider = openrouterMeta.provider;
          if (usage?.cost !== undefined) meta.costUsd = usage.cost;
          if (usage?.promptTokensDetails?.cachedTokens !== undefined) {
            meta.cachedTokens = usage.promptTokensDetails.cachedTokens;
          }
          if (usage?.completionTokensDetails?.reasoningTokens !== undefined) {
            meta.reasoningTokens =
              usage.completionTokensDetails.reasoningTokens;
          }
          return Object.keys(meta).length > 0 ? meta : undefined;
        }

        case "finish": {
          const endedAt = Date.now();
          // The whole think, first reasoning token to last — reasoning can
          // resume after the answer begins, and a turn that reasoned but never
          // answered (length cap, tool-only step) thought until the end.
          const thinkingMs =
            reasoningFirstAt === null
              ? undefined
              : textFirstAt === null
                ? endedAt - reasoningFirstAt
                : Math.max(reasoningLastAt ?? textFirstAt, textFirstAt) -
                  reasoningFirstAt;
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

    return toUIMessageStream<ToolSet, DialMessage>({
      stream: result.fullStream.pipeThrough(reviveLateReasoning()),
      sendSources: true,
      sendReasoning: true,
      messageMetadata,
      onError: describeStreamError,
    }) as ReadableStream<UIMessageChunk>;
  }

  /**
   * There is no server-side stream to rejoin — the stream *was* this tab.
   * Returning null tells useChat there is nothing to resume, which is the
   * honest answer rather than a silent retry of a finished turn.
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

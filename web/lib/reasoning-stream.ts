import type { TextStreamPart, ToolSet } from "ai";

type Part = TextStreamPart<ToolSet>;

/**
 * The reasoning text a raw OpenRouter chunk carries, if any.
 *
 * Mirrors what the provider itself reads: `reasoning_details` when present
 * (text entries, and summaries for models that only publish those), else the
 * flat `reasoning` string. Encrypted details and signature-only entries carry
 * no readable text and yield nothing.
 */
export function reasoningIn(raw: unknown): string {
  const delta = (raw as {
    choices?: Array<{
      delta?: {
        reasoning?: string | null;
        reasoning_details?: Array<{ type?: string; text?: string; summary?: string }> | null;
      } | null;
    }>;
  } | null)?.choices?.[0]?.delta;
  if (!delta) return "";
  const details = delta.reasoning_details;
  if (details && details.length > 0) {
    return details
      .map((detail) =>
        detail.type === "reasoning.text"
          ? (detail.text ?? "")
          : detail.type === "reasoning.summary"
            ? (detail.summary ?? "")
            : "",
      )
      .join("");
  }
  return delta.reasoning ?? "";
}

/** Prefix for reasoning this transform puts back. Legacy turns used another. */
export const RESUMED_REASONING_PREFIX = "reasoning-resumed-";

/**
 * Put the stream in the order things actually happened.
 *
 * The transcript renders a turn's parts in array order, and useChat appends a
 * part when it *starts* — later deltas grow the part where it already sits.
 * So a text part opened early keeps every later word at its early position,
 * and whatever arrived in between ends up looking as if it came after. Three
 * things about the provider made that routine:
 *
 *  - **It drops reasoning once content opens.** `@openrouter/ai-sdk-provider`
 *    stops emitting reasoning at the first truthy `delta.content` — including
 *    a lone "\n\n" that some models send mid-thought. With `includeRawChunks`
 *    each parsed chunk arrives *ahead of* the parts derived from it, so the
 *    reasoning it is about to discard can be re-emitted here. Only after the
 *    provider has opened text, or it would double.
 *  - **Whitespace opens a text part.** That "\n\n" became an empty answer
 *    sitting above the thinking it interrupted. Whitespace is buffered until
 *    real text arrives, and dropped if none does.
 *  - **Text resumes under its old id.** When reasoning resumes after real
 *    text, the open text part is closed; when text resumes it gets a new id,
 *    so it lands *after* the thought rather than being appended to the
 *    paragraph above it.
 *  - **A thought spans a search.** The provider keeps one reasoning part open
 *    from the first thinking token to the first answer token, so thinking
 *    that resumed after the search results grew the thought *above* them.
 *    A source arriving mid-thought marks it interrupted; if more reasoning
 *    follows, the thought is closed there and the rest becomes a new one.
 *    If none follows, nothing is split — the provider's closing metadata
 *    (reasoning signatures, which later turns send back) lands where it
 *    always did.
 *
 * Sources never split text: annotations ride along with content chunks, and
 * cutting an answer at every citation would shred its paragraphs.
 */
export function orderStream(): TransformStream<Part, Part> {
  /** The provider has opened a text part and so stopped emitting reasoning. */
  let providerText: string | null = null;
  /** The text part the UI currently has open, if any. */
  let uiText: string | null = null;
  /** Segments emitted for the current provider text part. */
  let segments = 0;
  /** Whitespace waiting for real text before it is allowed to open a part. */
  let pending = "";
  let resumed: string | null = null;
  let resumedCount = 0;
  /** The provider's open reasoning part, and the UI part it maps to now. */
  let providerReasoning: string | null = null;
  let uiReasoning: string | null = null;
  let reasoningSegments = 0;
  /** A source arrived while a thought was open. */
  let interrupted = false;

  type Controller = TransformStreamDefaultController<Part>;

  const closeText = (controller: Controller) => {
    if (uiText === null) return;
    controller.enqueue({ type: "text-end", id: uiText });
    uiText = null;
  };

  const closeResumed = (controller: Controller) => {
    if (resumed === null) return;
    controller.enqueue({ type: "reasoning-end", id: resumed });
    resumed = null;
  };

  return new TransformStream<Part, Part>({
    transform(part, controller) {
      switch (part.type) {
        case "raw": {
          // Swallowed either way: raw chunks exist only for this transform.
          if (providerText === null) return;
          const text = reasoningIn(part.rawValue);
          if (!text) return;
          if (resumed !== null && interrupted) closeResumed(controller);
          interrupted = false;
          if (resumed === null) {
            closeText(controller);
            resumed = `${RESUMED_REASONING_PREFIX}${++resumedCount}`;
            controller.enqueue({ type: "reasoning-start", id: resumed });
          }
          controller.enqueue({ type: "reasoning-delta", id: resumed, text });
          return;
        }

        case "text-start":
          providerText = part.id;
          segments = 0;
          pending = "";
          return;

        case "text-delta": {
          if (uiText === null && !part.text.trim()) {
            pending += part.text;
            return;
          }
          if (uiText === null) {
            closeResumed(controller);
            // The first segment keeps the provider's id; later ones are new.
            uiText = segments === 0 ? part.id : `${part.id}:${segments}`;
            segments += 1;
            controller.enqueue({ type: "text-start", id: uiText });
            const text = pending + part.text;
            pending = "";
            controller.enqueue({ ...part, id: uiText, text });
            return;
          }
          controller.enqueue({ ...part, id: uiText });
          return;
        }

        case "text-end":
          if (uiText !== null) {
            controller.enqueue({ ...part, id: uiText });
            uiText = null;
          }
          providerText = null;
          pending = "";
          return;

        // Thinking or a tool call after the answer has begun is a new step
        // in the timeline, not something that happened before the paragraph.
        case "reasoning-start":
          closeText(controller);
          providerReasoning = part.id;
          uiReasoning = part.id;
          reasoningSegments = 1;
          interrupted = false;
          controller.enqueue(part);
          return;

        case "reasoning-delta": {
          if (part.id !== providerReasoning) {
            controller.enqueue(part);
            return;
          }
          if (interrupted && uiReasoning !== null) {
            controller.enqueue({ type: "reasoning-end", id: uiReasoning });
            uiReasoning = null;
          }
          interrupted = false;
          if (uiReasoning === null) {
            uiReasoning = `${part.id}:${reasoningSegments++}`;
            controller.enqueue({ type: "reasoning-start", id: uiReasoning });
          }
          controller.enqueue({ ...part, id: uiReasoning });
          return;
        }

        case "reasoning-end":
          if (part.id !== providerReasoning) {
            controller.enqueue(part);
            return;
          }
          if (uiReasoning !== null) controller.enqueue({ ...part, id: uiReasoning });
          providerReasoning = null;
          uiReasoning = null;
          interrupted = false;
          return;

        case "source":
          if (uiReasoning !== null || resumed !== null) interrupted = true;
          controller.enqueue(part);
          return;

        case "tool-input-start":
          closeText(controller);
          controller.enqueue(part);
          return;

        case "finish-step":
        case "finish":
        case "error":
        case "abort":
          closeResumed(controller);
          controller.enqueue(part);
          return;

        default:
          controller.enqueue(part);
      }
    },
    flush(controller) {
      closeResumed(controller);
      closeText(controller);
      if (uiReasoning !== null) {
        controller.enqueue({ type: "reasoning-end", id: uiReasoning });
        uiReasoning = null;
      }
    },
  });
}

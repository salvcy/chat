import type { TextStreamPart, ToolSet } from "ai";

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

/**
 * Put back the reasoning the provider throws away.
 *
 * `@openrouter/ai-sdk-provider` stops emitting reasoning the moment the
 * content channel opens — and any truthy content opens it, including a lone
 * "\n\n" that some models send in the middle of thinking. Everything the
 * model reasoned after that was dropped on the floor: the trace froze, the
 * header flipped to "Thought for 0.7s", and the model went on thinking
 * invisibly until the answer arrived.
 *
 * With `includeRawChunks` the stream carries each parsed chunk ahead of the
 * parts the provider derives from it, so this can see reasoning the provider
 * is about to discard. It is only re-emitted once the provider has opened a
 * text part — before that the provider emits it itself, and doing both would
 * double it. The revived reasoning becomes its own part, closed when real
 * answer text resumes, so the transcript records the order things happened in.
 */
export function reviveLateReasoning(): TransformStream<
  TextStreamPart<ToolSet>,
  TextStreamPart<ToolSet>
> {
  let textOpen = false;
  let lateId: string | null = null;
  let lateCount = 0;

  const close = (
    controller: TransformStreamDefaultController<TextStreamPart<ToolSet>>,
  ) => {
    if (lateId === null) return;
    controller.enqueue({ type: "reasoning-end", id: lateId });
    lateId = null;
  };

  return new TransformStream({
    transform(part, controller) {
      switch (part.type) {
        case "raw": {
          if (!textOpen) return;
          const text = reasoningIn(part.rawValue);
          if (!text) return;
          if (lateId === null) {
            lateId = `late-reasoning-${++lateCount}`;
            controller.enqueue({ type: "reasoning-start", id: lateId });
          }
          controller.enqueue({ type: "reasoning-delta", id: lateId, text });
          return;
        }
        case "text-start":
          textOpen = true;
          controller.enqueue(part);
          return;
        case "text-delta":
          // Whitespace between thoughts does not end the thinking.
          if (part.text.trim()) close(controller);
          controller.enqueue(part);
          return;
        case "finish-step":
        case "finish":
        case "error":
        case "abort":
          close(controller);
          controller.enqueue(part);
          return;
        default:
          controller.enqueue(part);
      }
    },
    flush(controller) {
      close(controller);
    },
  });
}

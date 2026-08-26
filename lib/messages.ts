import type { DialDataParts, DialMetadata, RequestStatusData } from "./types";
import type { UIMessage } from "ai";

/**
 * Shared predicates about the *state* of an assistant turn.
 *
 * These live outside the components because two places need to agree on them:
 * ChatView tags a finished turn, and MessageBubble has to recognise an
 * untagged one at render time. If the two definitions drifted, a turn would
 * either lose its placeholder or grow a second one.
 */

type Message = UIMessage<DialMetadata>;

/** Content the transcript can actually show as an assistant response. */
export function hasRenderableResponse(message: Message): boolean {
  return message.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }
    return (
      part.type === "source-url" ||
      part.type === "file" ||
      part.type === "data-image"
    );
  });
}

/**
 * True when a turn started streaming and never reached its finish event.
 *
 * `durationMs` is only written by the `finish` handler, so metadata that has a
 * `startedAt` but no `durationMs` means the stream was cut off — almost always
 * the tab being closed or reloaded mid-answer. `onFinish` never ran for those,
 * so nothing tagged them; this is how they're recognised after the fact.
 */
export function streamNeverFinished(message: Message): boolean {
  const meta = message.metadata;
  if (!meta) return false;
  return meta.startedAt !== undefined && meta.durationMs === undefined;
}

/**
 * Best guess at why a turn has nothing to show, for rows that were never
 * tagged (closed tab, or written before the status part existed).
 */
export function inferRequestStatus(message: Message): RequestStatusData["kind"] {
  if (message.metadata?.finishReason === "abort") return "interrupted";
  return streamNeverFinished(message) ? "interrupted" : "empty";
}

/* --------------------------- wire formatting --------------------------- */

type DialMessage = UIMessage<DialMetadata, DialDataParts>;

function isImageReference(part: DialMessage["parts"][number]): boolean {
  if (part.type !== "file") return false;
  const dial = part.providerMetadata?.dial;
  return !!dial && typeof dial === "object" && dial.imageReference === true;
}

/**
 * Reduce a thread to what the text model should actually receive.
 *
 * Generated pixels stay local: the model gets a compact provenance note
 * instead of a multi-megabyte base64 payload, and local-only parts (the
 * request-status placeholder, image reference attachments) are dropped
 * entirely. This ran inside the HTTP transport's `prepareSendMessagesRequest`
 * when there was a request body to prepare; it is a wire-format concern
 * either way, which is why it lives here rather than in the view.
 */
export function messagesForTextModel(messages: DialMessage[]): DialMessage[] {
  return messages.flatMap((message) => {
    const parts = message.parts.flatMap((part) => {
      if (isImageReference(part)) return [];
      if (part.type === "data-requestStatus") return [];
      if (part.type !== "data-image") return [part];
      const outcome =
        part.data.status === "complete" ? "Generated image" : "Image request";
      return [
        { type: "text" as const, text: `[${outcome}: ${part.data.prompt}]` },
      ];
    });
    // A placeholder-only assistant turn has no model-visible content. Drop
    // that turn from the next request instead of sending an invalid empty
    // assistant message; partial responses keep their real text/reasoning.
    if (message.role === "assistant" && parts.length === 0) return [];
    return [{ ...message, parts }];
  });
}

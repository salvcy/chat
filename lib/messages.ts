import type { DialMetadata, RequestStatusData } from "./types";
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

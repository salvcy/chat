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

export type DialMessage = UIMessage<DialMetadata, DialDataParts>;

/**
 * Finish reasons that mean the reasoning was cut short or handed off, not
 * that it was the whole reply. A trace that stopped at the length cap is a
 * half-finished thought, and promoting it would present it as an answer.
 */
const NOT_A_FINISHED_REPLY = new Set([
  "length",
  "error",
  "tool-calls",
  "content-filter",
  "abort",
  "empty",
]);

/**
 * An answer that arrived entirely on the reasoning channel, moved to where
 * it belongs.
 *
 * Some models stream their whole reply as reasoning tokens and leave the
 * content channel empty — Kimi K2.5 does it routinely, and OpenRouter's
 * provider relays it faithfully (OpenRouterTeam/ai-sdk-provider#426). The
 * transcript then showed "Thought for 40s" over nothing, with the answer
 * folded inside the collapsed trace. When a turn *finishes normally* with
 * reasoning and no text, the reasoning was the reply: it becomes one text
 * part at the position of the first reasoning part, and the metadata says so.
 *
 * Returns null when there is nothing to promote, so callers can keep the
 * original object (and its identity) in the common case.
 */
export function promoteReasoningAnswer(message: DialMessage): DialMessage | null {
  if (message.role !== "assistant") return null;
  if (message.metadata?.answerInReasoning) return null;
  const hasText = message.parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
  if (hasText) return null;
  if (
    message.parts.some(
      (part) => part.type === "data-image" || part.type === "data-requestStatus",
    )
  ) {
    return null;
  }
  const reason = message.metadata?.finishReason;
  if (reason && NOT_A_FINISHED_REPLY.has(reason)) return null;
  // Never reached its finish event: the tab closed mid-thought.
  if (streamNeverFinished(message)) return null;

  const reasoning = message.parts
    .map((part) => (part.type === "reasoning" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  if (!reasoning) return null;

  const parts: DialMessage["parts"] = [];
  let placed = false;
  for (const part of message.parts) {
    if (part.type === "reasoning") {
      if (!placed) {
        parts.push({ type: "text", text: reasoning, state: "done" });
        placed = true;
      }
      continue;
    }
    // Empty text parts from a content channel that opened and said nothing.
    if (part.type === "text") continue;
    parts.push(part);
  }

  const metadata: DialMetadata = { ...message.metadata, answerInReasoning: true };
  // "Thought for" would now describe the answer itself.
  delete metadata.thinkingMs;
  return { ...message, parts, metadata };
}

function renderableWeight(message: DialMessage): number {
  let weight = 0;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      weight += part.text.length;
    } else if (
      part.type === "source-url" ||
      part.type === "file" ||
      part.type === "data-image"
    ) {
      weight += 1;
    }
  }
  return weight;
}

function trailingAssistant(messages: readonly DialMessage[]): DialMessage | null {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUser; index--) {
    if (messages[index].role === "assistant") return messages[index];
  }
  return null;
}

/**
 * Reconcile the three snapshots available when useChat finishes a request.
 *
 * The SDK's `message`, its `messages` history, and React's last rendered
 * history normally agree. A state replacement caused by realtime sync can
 * make one lag behind the other two, though, and trusting the empty one tags
 * a response the reader just watched stream as "No response was returned."
 * Pick the richest renderable copy belonging to this turn, then make sure it
 * is the copy that gets persisted.
 */
export function reconcileFinishedResponse(
  streamed: DialMessage,
  finished: readonly DialMessage[],
  observed: readonly DialMessage[],
): { messages: DialMessage[]; response: DialMessage | null } {
  const exact = [
    streamed,
    ...finished.filter(
      (message) => message.id === streamed.id && message.role === "assistant",
    ),
    ...observed.filter(
      (message) => message.id === streamed.id && message.role === "assistant",
    ),
  ].filter(hasRenderableResponse);

  // Some SDK transitions replace the provisional assistant id at the last
  // render. Only fall back to the assistant after the latest user turn when
  // no renderable exact-id copy exists, so an older answer can never satisfy
  // a genuinely empty new request.
  const candidates =
    exact.length > 0
      ? exact
      : [trailingAssistant(finished), trailingAssistant(observed)].filter(
          (message): message is DialMessage =>
            message !== null && hasRenderableResponse(message),
        );
  const response =
    candidates.sort((a, b) => renderableWeight(b) - renderableWeight(a))[0] ?? null;

  if (!response) return { messages: [...finished], response: null };

  const messages = [...finished];
  const exactIndex = messages.findIndex((message) => message.id === response.id);
  if (exactIndex >= 0) {
    messages[exactIndex] = response;
  } else {
    // Replace the empty provisional assistant for this turn when its id moved;
    // otherwise append the rendered response after its user prompt.
    const provisional = messages.findIndex(
      (message) => message.id === streamed.id && message.role === "assistant",
    );
    if (provisional >= 0) messages[provisional] = response;
    else messages.push(response);
  }
  return { messages, response };
}

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
  return messages.flatMap((raw) => {
    // Turns stored before promotion existed still carry their answer as
    // reasoning, which many models strip from history — the next turn would
    // lose the very reply it follows.
    const message = promoteReasoningAnswer(raw) ?? raw;
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

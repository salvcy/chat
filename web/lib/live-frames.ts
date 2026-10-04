import type { DialMessage } from "./conversations";

/**
 * Live frames: a streaming reply, mirrored to the account's other devices.
 *
 * The device that is streaming publishes the *tail* of its transcript — the
 * messages from the turn's user message on — a few times a second. The first
 * frame of a stream is a keyframe (the whole tail); after that each frame is a
 * patch against the one before, and a reply streams almost entirely as
 * appended text, so a patch is the few hundred characters that arrived since
 * the last one rather than the whole growing message. A device that missed a
 * frame (it connected mid-stream, or a socket dropped) asks for a keyframe and
 * ignores patches until one arrives.
 *
 * `base` is where the tail starts in the transcript and `prev` the id of the
 * message just before it, so a receiver can check that the rest of its
 * transcript is the one the tail belongs to. An edit or a regenerate on the
 * streaming device moves `base` back, which is how a truncation made there
 * shows up live here.
 *
 * Pure and framework-free; tested in `tests/live-frames.test.ts`.
 */

type Part = DialMessage["parts"][number];

export type LiveTail = {
  base: number;
  prev: string | null;
  messages: DialMessage[];
};

export type Patch =
  /** The text of part `p` of message `m` grew by `append`; `rest` replaces its other fields. */
  | { m: number; p: number; append: string; rest?: Omit<Part, "text"> }
  /** Part `p` of message `m`, whole. */
  | { m: number; p: number; part: Part }
  /** Message `m`'s flight recorder. */
  | { m: number; meta: DialMessage["metadata"] | null }
  /** Message `m`, whole. */
  | { m: number; message: DialMessage };

export type FrameBody =
  | { kind: "key"; tail: LiveTail }
  | { kind: "patch"; patch: Patch[] };

/** What a frame of a still-running stream may leave out. */
export type FrameEnvelope = {
  /** Random per stream, so frames of two streams never mix. */
  stream: string;
  /** Frame number within the stream, from 0. */
  n: number;
  body: FrameBody;
  /** The stream is over; this frame carries its final state. */
  done?: boolean;
};

const json = (value: unknown) => JSON.stringify(value ?? null);

function textOf(part: Part | undefined): string | null {
  const text = (part as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : null;
}

function withoutText(part: Part): Omit<Part, "text"> {
  const { text, ...rest } = part as Part & { text?: string };
  void text;
  return rest as Omit<Part, "text">;
}

/** Bytes (`data:`) or a handle to bytes in this tab (`blob:`). */
const isLocal = (url: string) => url.startsWith("data:") || url.startsWith("blob:");

/**
 * Drop what is too heavy, or too local, to mirror: the bytes of an attached
 * file or a generated image, and object URLs that mean nothing on another
 * device. The receiver keeps its own copy of a part it already has (see
 * `mergeKnown`), and the stored turn carries the rest once it is saved.
 */
export function stripHeavy(message: DialMessage): DialMessage {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.type === "file" && isLocal(part.url)) {
      changed = true;
      return { ...part, url: "" };
    }
    if (part.type === "data-image" && part.data.images.some((image) => isLocal(image.url))) {
      changed = true;
      return {
        ...part,
        data: {
          ...part.data,
          images: part.data.images.map((image) =>
            isLocal(image.url) ? { ...image, url: "" } : image,
          ),
        },
      };
    }
    return part;
  });
  return changed ? { ...message, parts } : message;
}

/** The tail to publish: the transcript from `base` on, stripped. */
export function tailOf(messages: readonly DialMessage[], base: number): LiveTail {
  return {
    base,
    prev: base > 0 ? (messages[base - 1]?.id ?? null) : null,
    messages: messages.slice(base).map(stripHeavy),
  };
}

/**
 * What changed between two tails, or null when nothing did. A keyframe when
 * the shape moved under it — a different base, a message gone, a part gone —
 * which in practice is only ever the start of a stream.
 */
export function diffTail(previous: LiveTail | null, next: LiveTail): FrameBody | null {
  if (
    !previous ||
    previous.base !== next.base ||
    previous.prev !== next.prev ||
    previous.messages.length > next.messages.length
  ) {
    return { kind: "key", tail: next };
  }

  const patch: Patch[] = [];
  next.messages.forEach((message, m) => {
    const before = previous.messages[m];
    if (before === message) return;
    if (
      !before ||
      before.id !== message.id ||
      before.role !== message.role ||
      before.parts.length > message.parts.length
    ) {
      patch.push({ m, message });
      return;
    }

    message.parts.forEach((part, p) => {
      const old = before.parts[p];
      if (old === part) return;
      const oldText = textOf(old);
      const newText = textOf(part);
      if (
        old &&
        old.type === part.type &&
        oldText !== null &&
        newText !== null &&
        newText.startsWith(oldText)
      ) {
        const rest = withoutText(part);
        const restMoved = json(withoutText(old)) !== json(rest);
        if (newText.length > oldText.length || restMoved) {
          patch.push({
            m,
            p,
            append: newText.slice(oldText.length),
            ...(restMoved ? { rest } : {}),
          });
        }
        return;
      }
      if (!old || json(old) !== json(part)) patch.push({ m, p, part });
    });

    if (json(before.metadata) !== json(message.metadata)) {
      patch.push({ m, meta: message.metadata ?? null });
    }
  });

  return patch.length > 0 ? { kind: "patch", patch } : null;
}

/**
 * Apply a frame. Null when a patch does not fit what is held — the receiver
 * then asks for a keyframe. Messages and parts that did not change keep their
 * identity, so a memoised bubble does not re-render for someone else's token.
 */
export function applyFrame(current: LiveTail | null, body: FrameBody): LiveTail | null {
  if (body.kind === "key") return body.tail;
  if (!current) return null;

  const messages = current.messages.slice();
  for (const op of body.patch) {
    if ("message" in op) {
      if (op.m > messages.length) return null;
      messages[op.m] = op.message;
      continue;
    }
    const message = messages[op.m];
    if (!message) return null;
    if ("meta" in op) {
      messages[op.m] = { ...message, metadata: op.meta ?? undefined };
      continue;
    }
    const parts = message.parts.slice();
    if ("part" in op) {
      if (op.p > parts.length) return null;
      parts[op.p] = op.part;
    } else {
      const old = parts[op.p];
      const oldText = textOf(old);
      if (!old || oldText === null) return null;
      parts[op.p] = { ...(op.rest ?? withoutText(old)), text: oldText + op.append } as Part;
    }
    messages[op.m] = { ...message, parts };
  }
  return { ...current, messages };
}

/**
 * Put back what `stripHeavy` left out, from the receiver's own copy of the
 * same message: an attachment the user sent is already in its transcript.
 */
export function mergeKnown(incoming: DialMessage, known: DialMessage | undefined): DialMessage {
  if (!known || known.id !== incoming.id) return incoming;
  let changed = false;
  const parts = incoming.parts.map((part, index) => {
    const mine = known.parts[index];
    if (!mine || mine.type !== part.type) return part;
    if (part.type === "file" && !part.url && mine.type === "file" && mine.url) {
      changed = true;
      return { ...part, url: mine.url };
    }
    if (part.type === "data-image" && mine.type === "data-image") {
      const images = part.data.images.map((image, at) => {
        const own = mine.data.images[at];
        return !image.url && own?.url ? { ...image, url: own.url } : image;
      });
      if (images.some((image, at) => image !== part.data.images[at])) {
        changed = true;
        return { ...part, data: { ...part.data, images } };
      }
    }
    return part;
  });
  return changed ? { ...incoming, parts } : incoming;
}

/** The transcript to show: what is held, with the live tail laid over it. */
export function overlay(
  local: readonly DialMessage[],
  tail: LiveTail,
): DialMessage[] | null {
  if (local.length < tail.base) return null;
  if (tail.base > 0 && local[tail.base - 1]?.id !== tail.prev) return null;
  const known = new Map(local.slice(tail.base).map((message) => [message.id, message]));
  return [
    ...local.slice(0, tail.base),
    ...tail.messages.map((message) => mergeKnown(message, known.get(message.id))),
  ];
}

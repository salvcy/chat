import type { UIMessageChunk } from "ai";
// The extension lets `node --test` load this file directly.
import { REMARK_MAX } from "./timeline.ts";

type Delta = Extract<UIMessageChunk, { type: "text-delta" | "reasoning-delta" }>;

export type SmoothOptions = {
  /** ms between reveals — one merged update per tick at most. */
  tick?: number;
  /** A burst is spread over the expected gap to the next one, within these. */
  minWindow?: number;
  maxWindow?: number;
  /** Thinking may take longer: nobody is waiting to read it, and a block
   *  that types out reads as work in progress where one that lands whole
   *  reads as a jump. */
  maxThinkingWindow?: number;
  /** Once the stream has ended, catch up within this. */
  busyWindow?: number;
  /** Once the answer is waiting behind the thinking, catch up within this. */
  answerWindow?: number;
  /** Floor on reveal speed in chars/s, so a tail never crawls. */
  minRate?: number;
  now?: () => number;
};

function isDelta(chunk: UIMessageChunk): chunk is Delta {
  return chunk.type === "text-delta" || chunk.type === "reasoning-delta";
}

/**
 * Chunks that carry nothing to read. They are not arrivals: a block of
 * thinking is announced by a `reasoning-start` a millisecond ahead of it, and
 * counting that would make every block look like it came after no silence.
 */
const BOOKKEEPING = new Set<UIMessageChunk["type"]>([
  "start",
  "start-step",
  "finish-step",
  "reasoning-start",
  "reasoning-end",
  "text-start",
  "text-end",
  "message-metadata",
]);

function isEnd(chunk: UIMessageChunk): boolean {
  return chunk.type === "finish" || chunk.type === "abort" || chunk.type === "error";
}

/**
 * Text queued behind something else that is clearly an answer, not a remark:
 * past the length `buildTimeline` holds back, or onto a second line. A remark
 * is held off screen anyway, so hurrying the thinking in front of it would
 * only make that thinking flash past for nothing.
 */
function answerWaiting(queue: readonly UIMessageChunk[]): boolean {
  let text: string | null = null;
  for (const chunk of queue) {
    if (chunk.type === "text-start") text = "";
    else if (text !== null && chunk.type === "text-delta") {
      text += chunk.delta;
      const trimmed = text.trim();
      if (trimmed.length > REMARK_MAX || trimmed.includes("\n")) return true;
    }
  }
  return false;
}

/** Where to end a piece of `text` near `budget`: after a word, never inside a surrogate pair. */
function cut(text: string, budget: number): number {
  if (budget >= text.length) return text.length;
  let at = Math.max(1, budget);
  const limit = Math.min(text.length, at + 12);
  let end = at;
  while (end < limit && !/\s/.test(text[end])) end++;
  // Finish the word when it ends close by; a very long one is cut where it is.
  if (end < text.length && !/\s/.test(text[end])) end = at;
  at = end;
  const code = text.charCodeAt(at - 1);
  if (code >= 0xd800 && code <= 0xdbff && at < text.length) at++;
  return at;
}

/**
 * Even out a bursty stream before it reaches the screen.
 *
 * Measured against real models through OpenRouter: with web search on, the
 * tool loop runs server-side and each round's reasoning arrives as one block
 * of ~800 characters after seconds of silence, and an answer's twenty chunks
 * can land inside 150ms. Rendered as they come, the transcript sat still and
 * then jumped. Here text is released at a steady pace instead: each burst is
 * spread over roughly the time until the next one is expected (an average of
 * recent gaps, within `minWindow`–`maxWindow`), so a model streaming token by
 * token is never more than `minWindow` behind, while a block arriving after a
 * long pause types out instead of appearing whole.
 *
 * Thinking gets the longer window. With search on, the gaps between rounds
 * are 2–26s, so a round's thinking can type out over a few seconds without
 * holding anything up — the search results queued behind it wait their turn
 * (they arrive a second or two later anyway), which is what keeps the order
 * on screen the order it happened in.
 *
 * It never reorders and never holds anything back for long. An answer
 * queued behind thinking means catch up within `answerWindow` (a short line
 * that may yet be a remark does not count — the timeline holds those back); the end of
 * the stream, within `busyWindow`; an abort or an error flushes at once. A
 * new arrival can extend the reveal but never cut short one in progress. The
 * text released in one tick goes out as a single merged delta, so a burst of
 * tiny chunks costs one render, not twenty.
 *
 * Downstream of the flight recorder: timings, ttft and throughput are
 * measured on arrival, before any of this.
 */
export function smoothStream(
  source: ReadableStream<UIMessageChunk>,
  {
    tick = 33,
    minWindow = 150,
    maxWindow = 1000,
    maxThinkingWindow = 4000,
    busyWindow = 200,
    answerWindow = 600,
    minRate = 240,
    now = () => Date.now(),
  }: SmoothOptions = {},
): ReadableStream<UIMessageChunk> {
  const queue: UIMessageChunk[] = [];
  let reader: ReadableStreamDefaultReader<UIMessageChunk>;
  let controller: ReadableStreamDefaultController<UIMessageChunk>;
  let backlog = 0;
  let done = false;
  let failure: { error: unknown } | null = null;
  let closed = false;
  let urgent = false;
  let gap = 300;
  // Silence is measured from the last chunk of any kind — a block of
  // thinking after ten quiet seconds is a burst even if no text came before.
  let lastArrival = now();
  let deadline = 0;
  let lastTick = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (closed || timer !== null) return;
    timer = setTimeout(run, Math.max(0, tick - (now() - lastTick)));
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    if (failure) controller.error(failure.error);
    else controller.close();
  };

  const run = () => {
    timer = null;
    if (closed) return;
    const t = now();
    const dt = Math.max(1, t - lastTick);
    lastTick = t;

    if (done || queue.some(isEnd)) deadline = Math.min(deadline, t + busyWindow);
    else if (answerWaiting(queue)) deadline = Math.min(deadline, t + answerWindow);
    let budget =
      urgent || t >= deadline
        ? Infinity
        : Math.max(
            Math.ceil((backlog * dt) / (deadline - t + dt)),
            Math.ceil((minRate * dt) / 1000),
          );

    // Text released this tick, merged per part, so a run of tiny chunks
    // reaches the transcript as one update.
    const out: { pending: Delta | null } = { pending: null };
    const flushPending = () => {
      if (out.pending) controller.enqueue(out.pending);
      out.pending = null;
    };

    while (queue.length > 0) {
      const head = queue[0];
      if (!isDelta(head)) {
        flushPending();
        controller.enqueue(head);
        queue.shift();
        continue;
      }
      if (budget <= 0) break;
      const take = cut(head.delta, budget);
      const piece = head.delta.slice(0, take);
      if (take >= head.delta.length) queue.shift();
      else queue[0] = { ...head, delta: head.delta.slice(take) };
      backlog -= take;
      budget -= take;
      const merged = out.pending;
      if (merged && merged.type === head.type && merged.id === head.id) {
        out.pending = { ...merged, delta: merged.delta + piece };
      } else {
        flushPending();
        out.pending = { ...head, delta: piece };
      }
    }
    flushPending();

    if (queue.length === 0 && done) finish();
    else if (queue.length > 0) schedule();
  };

  const pump = async () => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        const t = now();
        // Waking from idle: count the reveal from here, not from the last
        // tick seconds ago, or the first tick would release the whole burst.
        if (queue.length === 0) lastTick = t - tick;
        if (isDelta(value)) {
          gap = gap * 0.6 + (t - lastArrival) * 0.4;
          const cap = value.type === "reasoning-delta" ? maxThinkingWindow : maxWindow;
          backlog += value.delta.length;
          deadline = Math.max(deadline, t + Math.min(cap, Math.max(minWindow, gap)));
        }
        if (!BOOKKEEPING.has(value.type)) lastArrival = t;
        if (value.type === "abort" || value.type === "error") urgent = true;
        queue.push(value);
        schedule();
      }
    } catch (error) {
      failure = { error };
      urgent = true;
    }
    done = true;
    if (queue.length === 0) finish();
    else schedule();
  };

  return new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c;
      reader = source.getReader();
      void pump();
    },
    cancel(reason) {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}

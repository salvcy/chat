import type { SourceUrlUIPart } from "ai";
import type { DialMessage } from "./messages";
// The extension lets `node --test` load this file directly; the bundler
// accepts it (`allowImportingTsExtensions`).
import { dedupeSources } from "./sources.ts";

/**
 * A turn, as its work and then its answer.
 *
 * Models that search narrate between rounds — "I'll look up both versions.",
 * a search, more thinking, "Let me pin down the release date.", another
 * search — and only then answer. Rendered in stream order, each of those
 * lines read as the answer starting and then the model wandering back off to
 * think. So a turn is folded into one *activity* block — thoughts, searches
 * and those in-between remarks as steps, in the order they happened — and the
 * answer is the text after the last of the work.
 *
 * While streaming, text followed by any further work is a remark: the model
 * went back to thinking or searching after it. Once the turn has finished,
 * the last run of text is the answer even if something trails it — some
 * search engines attach their citations after the final paragraph, and that
 * must not fold the answer away.
 *
 * The remark/answer distinction is only known once the model either goes back
 * to work or keeps writing, so while streaming with search on, short text
 * right after the work — one sentence, under `REMARK_MAX` — is *held*: shown
 * nowhere until it either grows into an answer or more work arrives behind
 * it. Measured on DeepSeek, a remark is ~60 characters followed by a second of
 * silence while the search runs; an answer is past the limit within a few
 * hundred milliseconds. Without the hold, every remark appeared as the answer
 * starting and then jumped up into the activity a second later.
 *
 * Not every source is a search. Results from a search round arrive with no
 * position in the text (OpenRouter sends `start_index = end_index = 0`);
 * citations an engine attaches to the answer as it writes point at a span of
 * it. Those never make the text before them a remark — they are listed with
 * the work and the answer stays whole.
 *
 * Pure and framework-free so the rules are testable on their own.
 */

type Part = DialMessage["parts"][number];

export type ThoughtStep = {
  kind: "thought";
  key: string;
  text: string;
  /** Still streaming — the model is mid-thought. */
  live: boolean;
  /** ms from the request start, when measured (`DialMetadata.timings`). */
  startMs?: number;
  endMs?: number;
};

export type SearchStep = {
  kind: "search";
  key: string;
  /** Distinct pages, in the order they arrived. */
  sources: SourceUrlUIPart[];
  /** What was searched for, when the stream says. */
  query?: string;
  live: boolean;
};

/** Something the model said on its way to the answer. */
export type NoteStep = {
  kind: "note";
  key: string;
  text: string;
};

export type Step = ThoughtStep | SearchStep | NoteStep;

export type Block =
  | { kind: "activity"; key: string; steps: Step[] }
  | { kind: "text"; key: string; text: string }
  | {
      kind: "image";
      key: string;
      part: Extract<Part, { type: "data-image" }>;
    };

/** Longest text after the work that may still be a remark. */
export const REMARK_MAX = 120;

/** The first activity block's key, stable from the placeholder onwards. */
export const WORK_KEY = "work";

/** The id prefix the first revival transform gave reasoning it put back. */
const LEGACY_LATE = "late-reasoning-";

/**
 * Undo the order a previous build saved.
 *
 * Before `orderStream`, reasoning revived after a stray newline was appended
 * *after* the text part that newline had opened — and the answer then grew
 * inside that earlier part. So a saved turn reads [thought, answer, thought]
 * when what happened was [thought, thought, answer]. Those parts are
 * recognisable by their id, and each belongs just before the text part it
 * follows.
 */
function restoreLegacyOrder(parts: readonly Part[]): Part[] {
  if (!parts.some((part) => part.type === "reasoning" && part.id?.startsWith(LEGACY_LATE))) {
    return [...parts];
  }
  const out: Part[] = [];
  for (const part of parts) {
    if (part.type === "reasoning" && part.id?.startsWith(LEGACY_LATE)) {
      let at = -1;
      for (let index = out.length - 1; index >= 0; index--) {
        if (out[index].type === "text") {
          at = index;
          break;
        }
      }
      if (at >= 0) {
        out.splice(at, 0, part);
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

function toolName(part: Part): string | null {
  if (part.type === "dynamic-tool") return part.toolName;
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return null;
}

function queryOf(part: Part): string | undefined {
  const input = (part as { input?: unknown }).input;
  const query = (input as { query?: unknown } | null | undefined)?.query;
  return typeof query === "string" && query.trim() ? query.trim() : undefined;
}

function settledTool(part: Part): boolean {
  const state = (part as { state?: string }).state;
  return state === "output-available" || state === "output-error" || state === "output-denied";
}

/** One thing that happened, before it is assigned to the work or the answer. */
type Item =
  | { kind: "step"; step: ThoughtStep | SearchStep }
  | { kind: "text"; key: string; text: string }
  | { kind: "image"; key: string; part: Extract<Part, { type: "data-image" }> };

/** A citation attached to a span of the answer, rather than a search result. */
function isInlineCitation(part: Extract<Part, { type: "source-url" }>): boolean {
  const meta = part.providerMetadata?.openrouter as { endIndex?: unknown } | undefined;
  return typeof meta?.endIndex === "number" && meta.endIndex > 0;
}

/**
 * The parts in stream order, with adjacent thoughts, sources and text merged,
 * and inline citations set aside — they mark no boundary.
 */
function itemsOf(message: DialMessage): { items: Item[]; citations: SourceUrlUIPart[] } {
  const timings = message.metadata?.timings ?? {};
  const items: Item[] = [];
  const citations: SourceUrlUIPart[] = [];

  restoreLegacyOrder(message.parts).forEach((part, index) => {
    const key = `p${index}`;
    const tail = items.at(-1);

    if (part.type === "reasoning") {
      const live = part.state === "streaming";
      // Encrypted reasoning arrives as an empty part: nothing to show.
      if (!part.text.trim() && !live) return;
      const span = part.id ? timings[part.id] : undefined;
      // Consecutive thoughts are one thought: a provider part and the
      // reasoning revived after it are the same think, split by plumbing.
      if (tail?.kind === "step" && tail.step.kind === "thought") {
        const step = tail.step;
        // What split them was a paragraph break on the content channel, so
        // that is what goes back between them unless one is already there.
        const seam = /\s$/.test(step.text) || /^\s/.test(part.text) ? "" : "\n\n";
        step.text = step.text && part.text ? step.text + seam + part.text : step.text + part.text;
        step.live = step.live || live;
        if (span?.[1] !== undefined) step.endMs = span[1];
        else if (live) step.endMs = undefined;
        if (step.startMs === undefined) step.startMs = span?.[0];
        return;
      }
      items.push({
        kind: "step",
        step: { kind: "thought", key, text: part.text, live, startMs: span?.[0], endMs: span?.[1] },
      });
      return;
    }

    if (part.type === "source-url") {
      if (isInlineCitation(part)) {
        citations.push(part);
        return;
      }
      if (tail?.kind === "step" && tail.step.kind === "search") {
        tail.step.sources = dedupeSources([...tail.step.sources, part]);
      } else {
        items.push({ kind: "step", step: { kind: "search", key, sources: [part], live: false } });
      }
      return;
    }

    const name = toolName(part);
    if (name !== null) {
      // The only tool this app offers is web search, executed by OpenRouter.
      // If its call ever surfaces as a part, it is a search step like any
      // other; anything else is not ours to narrate.
      if (!/search/i.test(name)) return;
      items.push({
        kind: "step",
        step: { kind: "search", key, sources: [], query: queryOf(part), live: !settledTool(part) },
      });
      return;
    }

    if (part.type === "text") {
      // A whitespace-only part is plumbing (the content channel opening on a
      // newline), not a paragraph — and it must not cut a run of work in two.
      if (!part.text.trim()) return;
      if (tail?.kind === "text") tail.text += part.text;
      else items.push({ kind: "text", key, text: part.text });
      return;
    }

    if (part.type === "data-image") {
      items.push({ kind: "image", key: part.id ?? key, part });
    }
  });

  return { items, citations };
}

export function buildTimeline(
  message: DialMessage,
  {
    streaming = false,
    holdRemarks = false,
  }: {
    streaming?: boolean;
    /** Search is on, so short text after the work may be a remark. */
    holdRemarks?: boolean;
  } = {},
): Block[] {
  const { items, citations } = itemsOf(message);

  // Where the answer starts. While streaming it is only text with nothing
  // after it yet; once finished, the last run of text, whatever trails it.
  let end = items.length;
  if (!streaming) {
    while (end > 0 && items[end - 1].kind !== "text") end--;
    if (end === 0) end = items.length;
  }
  let start = end;
  while (start > 0 && items[start - 1].kind === "text") start--;

  // Too early to tell whether it is a remark or the answer.
  const pending = items
    .slice(start, end)
    .map((item) => (item.kind === "text" ? item.text : ""))
    .join("")
    .trim();
  const held =
    streaming &&
    holdRemarks &&
    start < end &&
    items.slice(0, start).some((item) => item.kind !== "image") &&
    pending.length <= REMARK_MAX &&
    !pending.includes("\n");

  const blocks: Block[] = [];
  let activity: Extract<Block, { kind: "activity" }> | null = null;
  const open = (key: string) => {
    // The first block of work keeps one key from the placeholder on, so it
    // never remounts mid-stream.
    const first = !blocks.some((block) => block.kind === "activity");
    activity = { kind: "activity", key: first ? WORK_KEY : key, steps: [] };
    blocks.push(activity);
    return activity;
  };
  const work = (key: string) => activity ?? open(key);

  // Before the answer: everything is work, and text there is a remark.
  for (const item of items.slice(0, start)) {
    if (item.kind === "image") {
      blocks.push(item);
      activity = null;
      continue;
    }
    const steps = work(item.kind === "text" ? item.key : item.step.key).steps;
    if (item.kind === "step") {
      steps.push(item.step);
      continue;
    }
    const last = steps.at(-1);
    if (last?.kind === "note") last.text = `${last.text.trimEnd()}\n\n${item.text.trim()}`;
    else steps.push({ kind: "note", key: item.key, text: item.text.trim() });
  }

  const answer: Block[] = [];
  for (const item of held ? [] : items.slice(start, end)) {
    if (item.kind === "text") answer.push({ kind: "text", key: item.key, text: item.text });
  }

  // After a finished answer: citations attached at the end belong with the
  // rest of the work, above the answer — never a block below it.
  const trailing: Block[] = [];
  for (const item of items.slice(end)) {
    if (item.kind === "image") trailing.push(item);
    else if (item.kind === "step") work(item.step.key).steps.push(item.step);
  }

  if (citations.length > 0) {
    work("citations").steps.push({
      kind: "search",
      key: "citations",
      sources: dedupeSources(citations),
      live: false,
    });
  }

  return [...blocks, ...answer, ...trailing].filter(
    (block) => block.kind !== "activity" || block.steps.length > 0,
  );
}

/** The answer's text, without the remarks folded into the work. */
export function answerTextOf(blocks: readonly Block[]): string {
  return blocks
    .filter((block): block is Extract<Block, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Total measured thinking in a block, or undefined when nothing was timed. */
export function thoughtMs(steps: readonly Step[]): number | undefined {
  let total = 0;
  let timed = false;
  for (const step of steps) {
    if (step.kind !== "thought") continue;
    if (step.startMs === undefined || step.endMs === undefined) continue;
    total += Math.max(0, step.endMs - step.startMs);
    timed = true;
  }
  return timed ? total : undefined;
}

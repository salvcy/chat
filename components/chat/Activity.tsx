"use client";

import type { SourceUrlUIPart } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Elapsed, PixelGrid } from "@/components/ui/Loader";
import Reveal from "@/components/ui/Reveal";
import { formatDuration } from "@/lib/format";
import { domainOf, labelOf } from "@/lib/sources";
import { thoughtMs, type SearchStep, type Step } from "@/lib/timeline";
import StreamText from "./StreamText";

/**
 * The work behind an answer — thinking, searching, and what the model said
 * along the way — as one block above it.
 *
 * While the model works, the header names what it is doing right now — the
 * title of the current thought when the model writes titles, "Searching the
 * web", "Reading 5 sources" — and each change rolls in rather than snapping.
 * Under it a window about seven lines tall follows the work as it happens:
 * thoughts type in, results drop into place, remarks appear, and older lines
 * glide up under a fade instead of jumping a line at a time (see `Reveal`).
 * When the answer starts the window folds up into the header, which settles
 * to "Thought for 4.3s · 3 sources". Opening it shows the same steps in full
 * on a hairline rail — after Beautiful UI's ThinkingState (beautifului.dev,
 * MIT).
 *
 * The live window and the opened view are one list rendered at two heights,
 * and the list only ever grows at its end while the model works — nothing
 * above the newest line changes, so nothing above it moves.
 *
 * Traces stay mono and muted — they are process, not content. Titles, page
 * names and the model's own remarks are sans, because someone wrote them.
 */

const EASE = [0.23, 1, 0.32, 1] as const;
/** The live window: seven lines of trace. */
const WINDOW = 7 * 21;
/** Longest header label before it is shortened. */
const LABEL_MAX = 56;

function Sparkle({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" />
    </svg>
  );
}

function Globe({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.4 8h11.2M8 2.25c1.5 1.6 2.25 3.5 2.25 5.75S9.5 12.15 8 13.75C6.5 12.15 5.75 10.25 5.75 8S6.5 3.85 8 2.25Z" />
    </svg>
  );
}

/** A remark: a short horizontal stroke, the quietest mark on the rail. */
function Remark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M4.5 6.5h7M4.5 9.5h4.5" />
    </svg>
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function clip(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1).trimEnd()}…` : text;
}

function sourcesIn(steps: readonly Step[]): SourceUrlUIPart[] {
  const seen = new Set<string>();
  const out: SourceUrlUIPart[] = [];
  for (const step of steps) {
    if (step.kind !== "search") continue;
    for (const source of step.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      out.push(source);
    }
  }
  return out;
}

function stepDuration(step: Step): number | undefined {
  if (step.kind !== "thought") return undefined;
  if (step.startMs === undefined || step.endMs === undefined) return undefined;
  return Math.max(0, step.endMs - step.startMs);
}

function searchLabel(step: SearchStep): string {
  if (step.query) return `Searched “${step.query}”`;
  return step.live ? "Searching the web" : "Searched the web";
}

/* ------------------------------ reading a thought ------------------------------ */

type Paragraph = { heading: boolean; text: string };

/** A line that is only a title: `**Checking the release notes**` or `## …`. */
const HEADING = /^(?:\*\*([^*\n]+)\*\*|#{1,4}\s+(\S[^\n]*))$/;

/**
 * A thought as paragraphs, with titles picked out. Reasoning summaries
 * (OpenAI's, Gemini's) title each section; elsewhere there are none and this
 * is just paragraphs. While it streams, a title still missing its closing
 * `**` is left out rather than flashing its asterisks for a tick.
 */
function paragraphsOf(text: string, live: boolean): Paragraph[] {
  const out: Paragraph[] = [];
  const chunks = text.split(/\n[ \t]*\n/);
  chunks.forEach((chunk, index) => {
    const value = chunk.trim();
    if (!value) return;
    if (live && index === chunks.length - 1 && /^\*\*[^*\n]*$/.test(value)) return;
    const [first, ...rest] = value.split("\n");
    const match = HEADING.exec(first.trim());
    if (!match) {
      out.push({ heading: false, text: value });
      return;
    }
    out.push({ heading: true, text: (match[1] ?? match[2]).trim() });
    const body = rest.join("\n").trim();
    if (body) out.push({ heading: false, text: body });
  });
  return out;
}

/** The thought's newest title, if the model writes them. */
function titleOf(text: string): string | undefined {
  const titles = paragraphsOf(text, true).filter((paragraph) => paragraph.heading);
  return titles.at(-1)?.text;
}

/**
 * The thought ends by deciding to search — "Let me search for both." — so a
 * search is what happens next. Intent only: "the search didn't show a date"
 * is about a search, not one coming.
 */
const SEARCH_INTENT =
  /\b(?:let me|let's|i'll|i will|i need to|i should|i'm going to|i must|time to)\s+(?:\w+\s+){0,2}?(?:search|look(?: it| them| this| that)? up|look for|browse|verify|check|find)\b/i;

function aboutToSearch(text: string): boolean {
  const sentences = text.trimEnd().slice(-240).split(/(?<=[.!?:])\s+/);
  return SEARCH_INTENT.test(sentences.at(-1) ?? "");
}

/**
 * True once `value` has held still for `ms` — a thought has stopped arriving.
 * `null` watches nothing, so settled blocks in the history set no timers.
 */
function useSettled(value: string | null, ms: number): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value !== null && settled === value;
}

/**
 * What the model is doing right now. OpenRouter runs the search loop
 * server-side and sends each round's thinking whole once the round is over,
 * then nothing while the next one runs — so after results the model is
 * reading them, and a thought that has stopped on a decision to search is
 * followed by one. Only once it has stopped: judged sentence by sentence as
 * it types out, "Let me check…" mid-thought flipped the label back and forth.
 */
function liveLabel(
  steps: readonly Step[],
  canSearch: boolean,
  paused: boolean,
): { id: string; text: string } {
  const thinking = { id: "thinking", text: "Thinking" };
  const searching = { id: "searching", text: "Searching the web" };
  const step = steps.at(-1);
  if (!step) return thinking;
  if (step.kind === "search") {
    // Results land over a tick or two; the count updates in place rather
    // than rolling the label once per tick.
    return step.live || step.sources.length === 0
      ? searching
      : { id: "reading", text: `Reading ${plural(step.sources.length, "source")}` };
  }
  if (step.kind === "note") return canSearch ? searching : thinking;
  // A thought with nothing to show yet — often a title still arriving —
  // keeps the label it follows, rather than rolling to "Thinking" and then
  // to its title a tick later.
  if (steps.length > 1 && paragraphsOf(step.text, true).length === 0) {
    return liveLabel(steps.slice(0, -1), canSearch, false);
  }
  if (canSearch && paused && aboutToSearch(step.text)) return searching;
  const title = titleOf(step.text);
  if (title) return { id: `title:${title}`, text: clip(title) };
  return thinking;
}

/* --------------------------------- pieces -------------------------------- */

/**
 * A label that rolls when it changes: the old one lifts away, the new one
 * rises into place, and the row's width eases to fit so nothing after it
 * jumps.
 */
function Swap({ id, children }: { id: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLSpanElement>(null);
  const resize = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element || reduce) return;
    const nodes = [...element.children] as HTMLElement[];
    const current = nodes.find((node) => node.dataset.id === id);
    const leaving = nodes.filter((node) => node !== current).at(-1);
    if (!current || !leaving) return;
    const from =
      resize.current?.playState === "running"
        ? element.getBoundingClientRect().width
        : leaving.offsetWidth;
    const to = current.offsetWidth;
    resize.current?.cancel();
    if (Math.abs(from - to) < 1) return;
    resize.current = element.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: 320,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
  }, [id, reduce]);

  return (
    <span ref={box} className="relative -my-1 inline-flex min-w-0 items-center overflow-y-clip py-1">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={id}
          data-id={id}
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : -8 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** The marker on the rail: a mark per kind, a breathing dot while live. */
function StepMark({ step, live }: { step: Step; live: boolean }) {
  return (
    <span className="absolute left-0 top-0 flex h-[21px] w-[13px] items-center justify-center text-muted">
      {live ? (
        <span
          className="size-[5px] rounded-full bg-foreground"
          style={{ animation: "dial-breathe 1.1s ease-in-out infinite" }}
        />
      ) : (
        <span className="flex" style={{ animation: "dial-fade-in 300ms ease-out both" }}>
          {step.kind === "thought" ? (
            <Sparkle className="h-[11px] w-[11px]" />
          ) : step.kind === "search" ? (
            <Globe className="h-3 w-3" />
          ) : (
            <Remark className="h-3 w-3" />
          )}
        </span>
      )}
    </span>
  );
}

/** A thought: mono paragraphs, sans titles, the newest words fading in. */
function Trace({ text, live }: { text: string; live: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {paragraphsOf(text, live).map((paragraph, index) =>
        paragraph.heading ? (
          <p
            key={index}
            className="text-[12.5px] font-medium leading-[21px] text-secondary"
            style={live ? { animation: "dial-fade-in 400ms ease-out both" } : undefined}
          >
            {paragraph.text}
          </p>
        ) : (
          <p key={index} className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[21px] text-muted">
            <StreamText text={paragraph.text} fade={live} />
          </p>
        ),
      )}
    </div>
  );
}

/** One search's results, numbered within that search. */
function SourceList({ sources }: { sources: SourceUrlUIPart[] }) {
  return (
    <div className="flex flex-col">
      {sources.map((source, index) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.url}
          className="-mx-1.5 flex h-7 min-w-0 items-center gap-2.5 rounded-chip px-1.5 transition-colors duration-150 hover:bg-hover"
          style={{
            animation: `dial-fade-up 360ms cubic-bezier(0.23,1,0.32,1) ${Math.min(index, 8) * 45}ms both`,
          }}
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-field font-mono text-[9.5px] tabular-nums text-muted shadow-hairline">
            {index + 1}
          </span>
          <span className="min-w-0 truncate text-[12.5px] text-foreground">
            <span className="dial-underline">{labelOf(source)}</span>
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
            {domainOf(source.url)}
          </span>
        </a>
      ))}
    </div>
  );
}

/** A step's title row — only when opened, and only among several steps. */
function StepTitle({ label, meta, live }: { label: string; meta?: string; live?: boolean }) {
  return (
    <div className="flex h-[21px] min-w-0 items-center gap-2">
      <span className={`truncate text-[12.5px] font-medium ${live ? "dial-shimmer" : "text-secondary"}`}>
        {label}
      </span>
      {meta && (
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted">{meta}</span>
      )}
    </div>
  );
}

function StepBody({ step, live, titled }: { step: Step; live: boolean; titled: boolean }) {
  if (step.kind === "note") {
    // The model's own words: sans, and no title over them.
    return (
      <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[21px] text-secondary">
        <StreamText text={step.text} fade={live} />
      </p>
    );
  }
  if (step.kind === "search") {
    return (
      <>
        <StepTitle
          label={searchLabel(step)}
          meta={step.sources.length > 0 ? plural(step.sources.length, "source") : undefined}
        />
        {step.sources.length > 0 && (
          <div className="mt-0.5">
            <SourceList sources={step.sources} />
          </div>
        )}
      </>
    );
  }
  const duration = stepDuration(step);
  return (
    <>
      {titled && (
        <StepTitle
          label={live ? "Thinking" : "Thought"}
          live={live}
          meta={duration !== undefined ? formatDuration(duration) : undefined}
        />
      )}
      {step.text.trim() ? (
        <div className={titled ? "mt-0.5" : ""}>
          <Trace text={step.text} live={live} />
        </div>
      ) : (
        <div className="h-[21px]" />
      )}
    </>
  );
}

/** Every step in the order it happened, on a hairline rail. */
function Steps({ steps, live, opened }: { steps: Step[]; live: boolean; opened: boolean }) {
  return (
    <ol className="relative pr-1.5 pt-1.5">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const current = live && last;
        return (
          <li
            key={step.key}
            className={`relative pl-6 ${last ? "" : "pb-3"}`}
            style={live ? { animation: "dial-fade-up 360ms cubic-bezier(0.23,1,0.32,1) both" } : undefined}
          >
            {!last && <span aria-hidden className="absolute bottom-0 left-[6px] top-[21px] w-px bg-line" />}
            <StepMark step={step} live={current} />
            {/* A lone step needs no title: the header above is it. And the
                live window never titles thoughts, so a second step arriving
                cannot change a line above the newest one. */}
            <StepBody step={step} live={current} titled={opened && steps.length > 1} />
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------- block --------------------------------- */

export default function Activity({
  steps,
  live,
  since,
  fallbackMs,
  canSearch,
}: {
  steps: Step[];
  /** The model is still working in this block. */
  live: boolean;
  /** When the turn began, so the live timer survives a remount. */
  since: number | undefined;
  /** "Thought for" from before per-step timings existed. */
  fallbackMs?: number;
  /** Web search was offered this turn. */
  canSearch: boolean;
}) {
  const [open, setOpen] = useState(false);

  const sources = sourcesIn(steps);
  const thoughts = steps.filter((step) => step.kind === "thought");
  const searches = steps.filter((step): step is SearchStep => step.kind === "search");
  const thinking = thoughtMs(steps) ?? (thoughts.length > 0 ? fallbackMs : undefined);
  const empty = steps.length === 0;

  const summary =
    thoughts.length > 0 ? (
      thinking !== undefined ? (
        <>
          Thought for{" "}
          <span className="font-mono text-[12px] tabular-nums">{formatDuration(thinking)}</span>
        </>
      ) : (
        "Thought"
      )
    ) : searches.length === 1 && searches[0].query ? (
      searchLabel(searches[0])
    ) : searches.length > 0 ? (
      "Searched the web"
    ) : (
      "Worked"
    );
  const sourceCount = sources.length > 0 ? ` · ${plural(sources.length, "source")}` : "";

  const tail = steps.at(-1);
  const paused = useSettled(
    live && tail ? `${tail.key}:${tail.kind === "search" ? tail.sources.length : tail.text.length}` : null,
    700,
  );
  const label = live ? liveLabel(steps, canSearch, paused) : null;
  // What a screen reader hears: the step, not the ticking timer, and once.
  const spoken =
    label?.text ??
    (thoughts.length > 0
      ? thinking !== undefined
        ? `Thought for ${formatDuration(thinking)}`
        : "Thought"
      : searches.length > 0
        ? "Searched the web"
        : "Worked") + sourceCount;

  return (
    <div>
      <button
        type="button"
        aria-expanded={empty ? undefined : open}
        disabled={empty}
        className="-mx-1.5 flex max-w-full items-center gap-2 rounded-control px-1.5 py-1 text-left transition-colors duration-100 enabled:hover:bg-hover-2"
        onClick={() => setOpen((value) => !value)}
      >
        <span
          key={live ? "live" : "done"}
          className="flex w-[15px] shrink-0 items-center justify-center"
          style={{ animation: "dial-fade-in 320ms ease-out both" }}
        >
          {live ? (
            <PixelGrid />
          ) : thoughts.length > 0 ? (
            <Sparkle className="h-3.5 w-3.5 text-muted" />
          ) : (
            <Globe className="h-3.5 w-3.5 text-muted" />
          )}
        </span>

        <span role="status" className="sr-only">
          {spoken}
        </span>
        <span aria-hidden className="flex min-w-0 items-center">
          <Swap id={label?.id ?? "done"}>
            {label !== null ? (
              <>
                <span className="dial-shimmer text-[13px] font-medium">{label.text}</span>
                <Elapsed since={since} />
              </>
            ) : (
              <span className="text-[13px] font-medium text-secondary">
                {summary}
                {sourceCount && <span className="text-muted">{sourceCount}</span>}
              </span>
            )}
          </Swap>
        </span>

        {!empty && (
          <svg
            viewBox="0 0 12 12"
            className={`h-3 w-3 shrink-0 text-muted transition-transform duration-300 ${open ? "rotate-180" : ""}`}
            style={{ animation: "dial-fade-in 320ms ease-out both" }}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
          </svg>
        )}
      </button>

      <Reveal mode={open ? "full" : live && !empty ? "follow" : "none"} max={WINDOW}>
        <Steps steps={steps} live={live} opened={open} />
      </Reveal>
    </div>
  );
}

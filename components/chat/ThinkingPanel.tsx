"use client";

import type { SourceUrlUIPart } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Elapsed, PixelGrid } from "@/components/ui/Loader";
import { formatDuration } from "@/lib/format";
import { domainOf, labelOf } from "@/lib/sources";

/**
 * Everything the model did before answering, in one line.
 *
 * Reasoning and web search are the same phase of work, so they share one
 * header: while it runs, the pixel-grid loader, a shimmering label and a live
 * timer; once the answer starts, a settled "Thought for 4.3s · 3 sources".
 * Expanding hangs the trace and the sources off a hairline rule, after
 * Beautiful UI's ThinkingState (beautifului.dev, MIT).
 *
 * The trace stays mono and muted — it is process, not content, and it never
 * competes with the answer. The sources are the one place a title gets sans:
 * a page title is something a person wrote.
 */
export default function ThinkingPanel({
  reasoning,
  sources,
  thinkingMs,
  startedAt,
  streaming,
  answerStarted,
  reasoningOpen,
}: {
  /** All reasoning parts, concatenated. Empty when the model didn't think. */
  reasoning: string;
  sources: SourceUrlUIPart[];
  thinkingMs: number | undefined;
  /** When the request began, so the live timer survives a remount. */
  startedAt: number | undefined;
  streaming: boolean;
  answerStarted: boolean;
  /** A reasoning part is still streaming — the model is mid-thought. */
  reasoningOpen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);

  // A trace only remains open into the answer when the reader explicitly
  // asked for it. Deriving this avoids a render-time state update.
  const visibleOpen = open && (!answerStarted || userToggled);

  // Live until the answer has begun *and* no reasoning is still arriving.
  // Keying this on the answer alone flipped the header to "Thought for 0.7s"
  // the moment a model emitted a newline, while it went on thinking.
  const live = streaming && (!answerStarted || reasoningOpen);
  const hasTrace = reasoning.trim().length > 0;
  const hasSources = sources.length > 0;

  if (!live && !hasTrace && !hasSources) return null;

  const expandable = hasTrace || hasSources;
  const sourceCount = hasSources
    ? `${sources.length} source${sources.length === 1 ? "" : "s"}`
    : null;

  return (
    <div className="mb-3">
      <button
        type="button"
        aria-expanded={expandable ? visibleOpen : undefined}
        disabled={!expandable}
        className="-mx-1.5 flex max-w-full items-center gap-2 rounded-control px-1.5 py-1 text-left transition-colors duration-100 enabled:hover:bg-hover-2 disabled:cursor-default"
        onClick={() => {
          if (!expandable) return;
          setUserToggled(true);
          setOpen((o) => !o);
        }}
      >
        {live ? (
          <PixelGrid />
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-muted" fill="currentColor" aria-hidden>
            <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" />
          </svg>
        )}

        <span role="status" className="flex min-w-0 items-center gap-2">
          {live ? (
            <>
              <span className="dial-shimmer whitespace-nowrap text-[13px] font-medium">
                {hasSources && !hasTrace ? "Searching the web" : "Thinking"}
              </span>
              <Elapsed since={startedAt} />
            </>
          ) : (
            <span
              className="truncate text-[13px] font-medium text-secondary"
              style={{ animation: "dial-fade-in 300ms ease-out both" }}
            >
              {thinkingMs !== undefined ? (
                <>
                  Thought for{" "}
                  <span className="font-mono text-[12px] tabular-nums">
                    {formatDuration(thinkingMs)}
                  </span>
                </>
              ) : hasTrace ? (
                "Thought"
              ) : (
                "Searched the web"
              )}
              {sourceCount && <span className="text-muted"> · {sourceCount}</span>}
            </span>
          )}
        </span>

        {expandable && (
          <svg
            viewBox="0 0 12 12"
            className={`h-3 w-3 shrink-0 text-muted transition-transform duration-300 ${visibleOpen ? "rotate-180" : ""}`}
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

      {/* While it thinks, the newest two lines of the trace show under the
          header, fading in from above. A collapsed "Thinking" with nothing
          moving reads as a hang on a long think — and when a model streams
          its whole reply on the reasoning channel, this is where it shows
          until the finish promotes it to the answer. */}
      {live && hasTrace && !visibleOpen && (
        <div
          aria-hidden
          className="relative ml-[6px] mt-1 flex max-h-[3.5em] flex-col justify-end overflow-hidden pl-4 text-[12px] [mask-image:linear-gradient(to_bottom,transparent,#000_65%)]"
        >
          <span className="absolute bottom-0 left-0 top-0 w-px bg-line" />
          <p className="whitespace-pre-wrap font-mono text-[12px] leading-[1.75] text-muted">
            {reasoning.slice(-480)}
          </p>
        </div>
      )}

      <AnimatePresence initial={false}>
        {visibleOpen && expandable && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="relative ml-[6px] mt-1 pl-4">
              <span aria-hidden className="absolute bottom-1 left-0 top-0 w-px bg-line" />

              {hasTrace && (
                <div className="dial-scroll max-h-72 overflow-y-auto py-1 pr-1">
                  <p className="whitespace-pre-wrap font-mono text-[12px] leading-[1.75] text-muted">
                    {reasoning}
                  </p>
                </div>
              )}

              {hasSources && (
                <div className={`flex flex-col gap-px ${hasTrace ? "mt-2 border-t border-line pt-2" : "py-0.5"}`}>
                  {sources.map((source, index) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={source.url}
                      className="-mx-1.5 flex min-h-7 min-w-0 items-center gap-2.5 rounded-chip px-1.5 transition-colors duration-150 hover:bg-hover"
                      style={{
                        animation: `dial-fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${Math.min(index, 8) * 60}ms both`,
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
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

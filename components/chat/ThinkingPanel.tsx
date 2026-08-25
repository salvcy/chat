"use client";

import type { SourceUrlUIPart } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { formatDuration } from "@/lib/format";
import { domainOf, labelOf } from "@/lib/sources";

/**
 * Everything the model did before answering, in one line.
 *
 * Reasoning and web search used to be two stacked telemetry panels, which put
 * two disclosure rows above every answer and made a short reply look buried.
 * They're the same phase of work, so they collapse into one: the header says
 * how long it thought and how many sources it read, and expanding shows the
 * trace and source domains. The answer keeps its own compact citation row.
 *
 * Still telemetry, so still mono and muted — it never competes with the answer.
 */
export default function ThinkingPanel({
  reasoning,
  sources,
  thinkingMs,
  streaming,
  answerStarted,
}: {
  /** All reasoning parts, concatenated. Empty when the model didn't think. */
  reasoning: string;
  sources: SourceUrlUIPart[];
  thinkingMs: number | undefined;
  streaming: boolean;
  answerStarted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);

  // A trace only remains open into the answer when the reader explicitly
  // asked for it. Deriving this avoids a render-time state update.
  const visibleOpen = open && (!answerStarted || userToggled);

  const live = streaming && !answerStarted;
  const hasTrace = reasoning.trim().length > 0;
  const hasSources = sources.length > 0;

  if (!live && !hasTrace && !hasSources) return null;

  const label = live
    ? hasSources && !hasTrace
      ? "searching the web…"
      : "thinking…"
    : [
        thinkingMs !== undefined
          ? `thought for ${formatDuration(thinkingMs)}`
          : hasTrace
            ? "thought"
            : null,
        hasSources
          ? `${sources.length} source${sources.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

  const expandable = hasTrace || hasSources;

  return (
    <div className="mb-4">
      <button
        type="button"
        aria-expanded={expandable ? visibleOpen : undefined}
        className="flex items-center gap-2 rounded-full border border-hairline bg-surface px-2.5 py-1.5 font-mono text-[10px] tracking-wide text-muted transition-colors hover:border-hairline-strong hover:text-foreground"
        onClick={() => {
          if (!expandable) return;
          setUserToggled(true);
          setOpen((o) => !o);
        }}
      >
        {expandable && (
          <motion.span
            animate={{ rotate: visibleOpen ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="inline-block text-[9px]"
          >
            ▸
          </motion.span>
        )}
        <span className={live ? "dial-shimmer font-medium" : ""}>{label}</span>
        {live && (
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-1 w-1 rounded-full bg-muted"
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {visibleOpen && expandable && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="ml-3 mt-2.5 border-l border-hairline pl-4">
              {hasTrace && (
                <div className="dial-scroll max-h-72 overflow-y-auto pr-1">
                  <p className="whitespace-pre-wrap py-0.5 font-mono text-[11px] leading-[1.75] text-muted">
                    {reasoning}
                  </p>
                </div>
              )}

              {hasTrace && hasSources && (
                <div className="my-2 h-px bg-hairline" />
              )}

              {hasSources && (
                <div className="space-y-0.5 py-0.5">
                  {sources.map((source, index) => (
                    <motion.a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={labelOf(source)}
                      initial={{ opacity: 0, x: -3 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.16, delay: index * 0.03 }}
                      className="flex min-w-0 items-center gap-2 py-0.5 font-mono text-[11px] text-muted transition-colors hover:text-foreground"
                    >
                      <span className="w-3 shrink-0 text-right opacity-65">
                        {index + 1}
                      </span>
                      <span className="opacity-35">·</span>
                      <span className="truncate">{domainOf(source.url)}</span>
                    </motion.a>
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

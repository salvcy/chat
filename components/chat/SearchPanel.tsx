"use client";

import type { SourceUrlUIPart } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Web-search activity — telemetry, like the reasoning trace. The web_search
 * tool is provider-executed, so the activity signal is the arrival of
 * `source-url` parts: while the message is streaming and no answer text has
 * landed yet, the header glows "searching"; once sources arrive they list
 * here (title · domain, collapsible). Text only, no favicons, no cards.
 */
export default function SearchPanel({
  sources,
  searching,
}: {
  sources: SourceUrlUIPart[];
  searching: boolean;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-3">
      <button
        className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-muted transition-colors hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="inline-block"
        >
          ▸
        </motion.span>
        <svg
          viewBox="0 0 16 16"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <span className={searching ? "dial-shimmer font-medium" : ""}>
          {searching ? "searching the web…" : "searched the web"}
        </span>
        {!searching && sources.length > 0 && (
          <span className="text-muted">· {sources.length}</span>
        )}
        {searching && (
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
        {open && sources.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="ml-1 mt-2 border-l border-hairline pl-4">
              {sources.map((s, i) => (
                <motion.a
                  key={s.sourceId ?? i}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.04 }}
                  className="block truncate py-0.5 font-mono text-[12px] text-muted transition-colors hover:text-foreground"
                >
                  {s.title && !/[^\x00-\x7F]{3,}/.test(s.title)
                    ? s.title
                    : domain(s.url)}
                  <span className="opacity-60"> · {domain(s.url)}</span>
                </motion.a>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

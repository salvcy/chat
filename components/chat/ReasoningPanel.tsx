"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

/**
 * The reasoning trace is telemetry. While it streams, the header glows with
 * a side-to-side shimmer; once the answer starts it auto-collapses so it
 * never competes. The trace itself is mono, muted, hairline-left.
 */
export default function ReasoningPanel({
  text,
  streaming,
  answerStarted,
}: {
  text: string;
  streaming: boolean;
  answerStarted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [collapsedForAnswer, setCollapsedForAnswer] = useState(false);

  if (answerStarted && !collapsedForAnswer && !userToggled) {
    setCollapsedForAnswer(true);
    setOpen(false);
  }

  const live = streaming && !answerStarted;

  return (
    <div className="mb-3">
      <button
        className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-muted transition-colors hover:text-foreground"
        onClick={() => {
          setUserToggled(true);
          setOpen((o) => !o);
        }}
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="inline-block"
        >
          ▸
        </motion.span>
        <span className={live ? "dial-shimmer font-medium" : ""}>
          {live ? "reasoning…" : "reasoning"}
        </span>
        {live && (
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-1 w-1 rounded-full bg-muted"
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{
                  duration: 1,
                  repeat: Infinity,
                  delay: i * 0.2,
                }}
              />
            ))}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="dial-scroll ml-1 mt-2 max-h-72 overflow-y-auto border-l border-hairline pl-4 pr-1">
              <p className="whitespace-pre-wrap py-0.5 font-mono text-[12px] leading-relaxed text-muted">
                {text}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/** A few starting points — cheaper than staring at an empty box. */
const PRESETS: Array<{ label: string; text: string }> = [
  {
    label: "terse",
    text: "Answer in as few words as the question allows. No preamble, no summary of what you just said, no offers of further help.",
  },
  {
    label: "socratic",
    text: "Before answering, state the strongest objection to the premise of the question. Then answer. Flag where you are uncertain rather than smoothing over it.",
  },
  {
    label: "engineer",
    text: "You are a senior engineer reviewing code. Prefer correctness over agreement. Point out failure modes, edge cases and simpler alternatives. Show code, not prose about code.",
  },
];

const MAX = 8000;

/**
 * Per-conversation system prompt — a v1 core feature that never shipped.
 * It's stored on the conversation and sent with each turn; the route
 * strips any system message the client puts in the transcript, so this is
 * the only channel for it.
 */
export default function SystemPrompt({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        onSave(draft.slice(0, MAX));
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, onSave, onClose]);

  const commit = () => {
    onSave(draft.slice(0, MAX));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-chrome/70 px-3 pt-[12vh] backdrop-blur-md sm:px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-prompt-title"
        className="w-full max-w-[580px] overflow-hidden rounded-[24px] border border-hairline-strong bg-panel/95 shadow-[0_28px_100px_var(--shadow)] backdrop-blur-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between border-b border-hairline px-4 py-3">
          <span id="conversation-prompt-title" className="text-sm font-medium text-foreground">
            Conversation prompt
          </span>
          <span className="font-mono text-[10px] text-muted">
            {draft.length}/{MAX}
          </span>
        </div>

        <textarea
          ref={ref}
          value={draft}
          maxLength={MAX}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Give the model standing guidance for this conversation…"
          className="dial-scroll h-56 w-full resize-none bg-transparent px-4 py-4 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted"
        />

        <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline px-4 py-2.5">
          <span className="font-mono text-[10px] text-muted">presets</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => setDraft(p.text)}
              className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-hairline px-4 py-2.5">
          <button
            onClick={() => setDraft("")}
            disabled={draft.length === 0}
            className="font-mono text-[11px] text-muted transition-colors hover:text-foreground disabled:opacity-30 disabled:hover:text-muted"
          >
            clear
          </button>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-muted">⌘⏎ save</span>
            <button
              onClick={onClose}
              className="rounded-full px-3 py-1 font-mono text-[11px] text-muted transition-colors hover:text-foreground"
            >
              cancel
            </button>
            <button
              onClick={commit}
            className="rounded-full bg-invert-fill px-4 py-1.5 font-mono text-[10px] text-invert-text"
            >
              save
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

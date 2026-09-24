"use client";

import Button from "@/components/ui/Button";
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-3 pt-[12vh] backdrop-blur-[2px] sm:px-4"
      onClick={onClose}
      style={{ animation: "dial-fade-in 150ms ease-out both" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-prompt-title"
        className="w-full max-w-[580px] overflow-hidden rounded-window bg-panel shadow-overlay"
        style={{
          animation: "dial-pop-in 200ms cubic-bezier(0.23,1,0.32,1) both",
          transformOrigin: "top center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 id="conversation-prompt-title" className="text-[14px] font-semibold text-foreground">
              Conversation prompt
            </h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Standing guidance, sent with every turn in this conversation.
            </p>
          </div>
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {draft.length}/{MAX}
          </span>
        </div>

        <textarea
          ref={ref}
          value={draft}
          maxLength={MAX}
          aria-label="Conversation prompt"
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Give the model standing guidance for this conversation…"
          className="dial-scroll block h-56 w-full resize-none bg-transparent px-4 py-4 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted"
        />

        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2.5">
          <span className="mr-1 text-[12px] font-medium text-muted">Presets</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setDraft(p.text)}
              className="h-6 rounded-full bg-hover px-2.5 text-[12px] text-secondary transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.97]"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-line bg-hover px-4 py-2.5">
          <Button
            variant="quiet"
            size="xs"
            onClick={() => setDraft("")}
            disabled={draft.length === 0}
          >
            Clear
          </Button>
          <div className="flex items-center gap-1.5">
            <span className="mr-1.5 hidden items-center gap-1 text-[11.5px] text-muted sm:flex">
              <span className="dial-kbd">⌘</span>
              <span className="dial-kbd">⏎</span>
              save
            </span>
            <Button variant="quiet" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="xs" onClick={commit}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import type { OpenRouterModel, ReasoningEffort } from "@/lib/types";
import Dropdown from "@/components/ui/Dropdown";
import { useEffect, useRef } from "react";

/**
 * The composer — the one persistent object on screen. A floating glass
 * capsule holding a borderless textarea, the model tuner, and the
 * reasoning / search menus. Enter sends, Shift+Enter is a newline.
 */
export default function Composer({
  input,
  setInput,
  onSend,
  busy,
  reasoning,
  setReasoning,
  search,
  setSearch,
  model,
  models,
  onOpenSwitcher,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  reasoning: ReasoningEffort;
  setReasoning: (v: ReasoningEffort) => void;
  search: boolean;
  setSearch: (v: boolean) => void;
  model: string;
  models: OpenRouterModel[];
  onOpenSwitcher: () => void;
}) {
  const canSend = !busy && input.trim().length > 0;
  const taRef = useRef<HTMLTextAreaElement>(null);

  // auto-grow the textarea
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [input]);

  const shortModel = model.split("/")[1] ?? model;
  const modelName = models.find((m) => m.id === model)?.name;

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="rounded-[24px] border border-hairline bg-surface shadow-[0_8px_40px_rgba(0,0,0,0.18)] backdrop-blur-[20px]">
        <textarea
          ref={taRef}
          className="dial-scroll max-h-[180px] min-h-[52px] w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Message…"
          rows={1}
        />

        <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
          <div className="flex min-w-0 items-center gap-0.5">
            {/* model tuner */}
            <button
              onClick={onOpenSwitcher}
              title="Switch model (⌘K)"
              className="flex max-w-[200px] items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:text-foreground"
            >
              <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="8" cy="8" r="5.5" />
                <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" />
              </svg>
              <span className="truncate">{modelName ?? shortModel}</span>
            </button>
            <span className="px-0.5 text-muted/50">·</span>

            <Dropdown
              label="reasoning"
              value={reasoning}
              onChange={(v) => setReasoning(v as ReasoningEffort)}
              options={[
                { value: "off", label: "off" },
                { value: "low", label: "low" },
                { value: "medium", label: "medium" },
                { value: "high", label: "high" },
              ]}
            />

            <Dropdown
              label="search"
              value={search ? "on" : "off"}
              onChange={(v) => setSearch(v === "on")}
              options={[
                { value: "off", label: "off", hint: "model knowledge" },
                { value: "on", label: "on", hint: "live web" },
              ]}
            />
          </div>

          <button
            onClick={onSend}
            disabled={!canSend}
            aria-label="Send"
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-150 ${
              canSend
                ? "bg-invert-fill text-invert-text"
                : "border border-hairline text-muted opacity-40"
            }`}
          >
            {busy ? (
              <span className="block h-3.5 w-3.5 animate-pulse rounded-full bg-current" />
            ) : (
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

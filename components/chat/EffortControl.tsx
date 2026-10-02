"use client";

import { useEffect, useRef, useState } from "react";
import Segmented from "@/components/ui/Segmented";
import type { ReasoningEffort } from "@/lib/types";

const LABEL: Record<ReasoningEffort, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};

const DESCRIPTION: Record<ReasoningEffort, string> = {
  off: "Answers straight away, without thinking first.",
  minimal: "A quick check before answering.",
  low: "Thinks briefly. Fast and inexpensive.",
  medium: "A balance of depth and speed.",
  high: "Thinks longer on hard problems.",
  xhigh: "As deep as this model goes. Slowest and costliest.",
};

/**
 * How hard the model thinks, as one word in the composer.
 *
 * It replaced a "Think · medium ⌄" menu: a label, a value and a chevron for
 * one setting. The trigger is now the sparkle the transcript uses for
 * thinking plus the level — "Medium" — and, when thinking is off, a muted
 * "Think" that invites turning it on. A selection among peers, so on is a
 * quiet fill rather than an inversion. The levels open as a sliding
 * segmented control, since effort is a scale and reads as one; arrow keys
 * move along it.
 */
export default function EffortControl({
  value,
  options,
  defaultEffort,
  onChange,
  disabled = false,
}: {
  value: ReasoningEffort;
  /** Exactly what the model accepts, low→high — `effortOptions(caps)`. */
  options: ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
  onChange: (next: ReasoningEffort) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = open && !disabled;
  const on = value !== "off";

  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    // Land on the selected level, so the arrow keys work immediately.
    ref.current
      ?.querySelector<HTMLButtonElement>("[role=radio][aria-checked=true]")
      ?.focus();
    return () => document.removeEventListener("mousedown", onDoc);
  }, [isOpen]);

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(e) => {
        if (!isOpen) return;
        if (e.key === "Escape" || e.key === "Enter") {
          // Escape is also "stop generating" further up; this one is ours.
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`Reasoning: ${LABEL[value].toLowerCase()}`}
        title="Reasoning effort"
        onClick={() => setOpen((current) => !current)}
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:opacity-35 ${
          on || isOpen
            ? "bg-hover-2 text-foreground"
            : "text-muted hover:bg-hover-2 hover:text-foreground"
        }`}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden>
          <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" />
        </svg>
        <span>{on ? LABEL[value] : "Think"}</span>
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Reasoning effort"
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(320px,calc(100vw-72px))] origin-bottom-left rounded-card bg-panel p-3 shadow-overlay"
          style={{ animation: "dial-pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          <div className="mb-2.5 flex items-baseline justify-between gap-3 px-0.5">
            <span className="text-[12.5px] font-medium text-foreground">Reasoning</span>
            {defaultEffort && defaultEffort !== "off" && (
              <span className="font-mono text-[10.5px] text-muted">
                default {defaultEffort === "xhigh" ? "max" : defaultEffort}
              </span>
            )}
          </div>
          <Segmented
            label="Reasoning effort"
            value={value}
            options={options}
            onChange={onChange}
            labels={LABEL}
          />
          <p
            key={value}
            className="mt-2.5 px-0.5 text-[12px] leading-relaxed text-muted"
            style={{ animation: "dial-fade-in 200ms ease-out both" }}
          >
            {DESCRIPTION[value]}
          </p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { formatContext, formatInOutPrice } from "@/lib/format";
import { modelDisplayName, modelFor } from "@/lib/capabilities";
import type { ChatSettings, OpenRouterModel } from "@/lib/types";

function greetingFor(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The empty state is an invitation, not a logo screen.
 *
 * Two lines, two weights of ink — who and when in the muted one, the question
 * in the full one — after Beautiful UI's harness greeting. It sits at the
 * bottom of the transcript area, so with the composer docked mid-canvas the
 * two read as one group; the first message lets the composer settle and this
 * scrolls away with the rest of the empty transcript.
 *
 * Under it, the one useful piece of context: what the selected model can do.
 */
export default function EmptyState({
  settings,
  models,
  userName,
  onOpenModel,
}: {
  settings: ChatSettings;
  models: OpenRouterModel[];
  userName?: string;
  onOpenModel: () => void;
}) {
  // Read once: a greeting that changes under the reader mid-sentence is
  // worse than one that is a few minutes stale.
  const [hour] = useState(() => new Date().getHours());
  const firstName = userName?.trim().split(/\s+/)[0];

  const model = modelFor(settings.model, models);
  const compactPrice = formatInOutPrice(model)
    .replace(/\.00/g, "")
    .replace(" M tok", "/M");
  const chips = [
    model?.contextLength ? formatContext(model.contextLength) : null,
    compactPrice || null,
    model?.capabilities.reasoning ? "think" : null,
    model?.capabilities.tools ? "web" : null,
    model?.capabilities.vision ? "vision" : null,
    model?.capabilities.imageGeneration ? "image" : null,
  ].filter((chip): chip is string => Boolean(chip));

  return (
    <section
      className="empty-state flex h-full flex-col justify-end px-1 pb-5"
      style={{ animation: "dial-fade-up 420ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {/* The ocean swims behind this; the pool keeps the words above clear water. */}
      <div className="dial-ocean-pool">
        <h1 className="text-balance text-[27px] font-medium leading-[1.2] tracking-[-0.03em] sm:text-[32px]">
          <span className="block text-muted">
            {greetingFor(hour)}
            {firstName ? `, ${firstName}` : ""}
          </span>
          <span className="block text-foreground">What are you working on?</span>
        </h1>

        <div className="mt-4 flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            onClick={onOpenModel}
            className="dial-squircle group flex h-7 min-w-0 items-center gap-2 bg-hover pl-2.5 pr-2 text-[12.5px] [--sq:9px] font-medium text-secondary transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.98]"
            title="Change model (⌘K)"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-[1.5px] bg-foreground/60" />
            <span className="truncate">{modelDisplayName(settings.model, models)}</span>
            <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m4.5 2.75 3.25 3.25-3.25 3.25" />
            </svg>
          </button>
          {chips.length === 0 ? (
            <span className="font-mono text-[11px] text-muted">loading capabilities…</span>
          ) : (
            chips.map((chip) => (
              <span
                key={chip}
                className="dial-squircle flex h-6 items-center px-2 font-mono text-[11px] text-muted shadow-hairline [--sq:7px]"
              >
                {chip}
              </span>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

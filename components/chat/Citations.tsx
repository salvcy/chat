"use client";

import type { SourceUrlUIPart } from "ai";
import { dedupeSources, domainOf, labelOf } from "@/lib/sources";

/**
 * Citations, as chips.
 *
 * This was once a hairline-framed block listing every source on its own line,
 * which for a five-source answer was taller than the answer itself, and then
 * a row of bare `[1] [2] [3]` links that said nothing until hovered. Now it is
 * one wrapping row of small chips — number and domain — after Beautiful UI's
 * ToolChips: still a single line for a typical answer, and legible at rest.
 */
export default function Citations({ sources }: { sources: SourceUrlUIPart[] }) {
  const unique = dedupeSources(sources);
  if (unique.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {unique.map((s, i) => (
        <a
          key={s.url}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${labelOf(s)} · ${domainOf(s.url)}`}
          aria-label={`Source ${i + 1}: ${labelOf(s)}`}
          className="group/source flex h-6 max-w-[220px] items-center gap-1.5 rounded-full bg-hover pl-1 pr-2.5 text-[11.5px] text-secondary transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.97]"
          style={{
            animation: `dial-pop-in 200ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 8) * 40}ms both`,
          }}
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-panel font-mono text-[9.5px] tabular-nums text-muted shadow-hairline group-hover/source:text-foreground">
            {i + 1}
          </span>
          <span className="truncate">{domainOf(s.url)}</span>
        </a>
      ))}
    </div>
  );
}

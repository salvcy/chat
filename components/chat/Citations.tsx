"use client";

import type { SourceUrlUIPart } from "ai";
import { dedupeSources, domainOf, labelOf } from "@/lib/sources";

/**
 * Citations, minimized.
 *
 * This used to be a hairline-framed block listing every source on its own
 * line, which for a five-source answer was taller than the answer itself. Now
 * it's a single tight row of numbered links — `[1] [2] [3]` — each linking out, with
 * the title and domain on hover. The data is all still reachable; it just
 * stops competing with the prose for vertical space.
 */
export default function Citations({ sources }: { sources: SourceUrlUIPart[] }) {
  const unique = dedupeSources(sources);
  if (unique.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[9px] text-muted">
      <span className="mr-0.5 uppercase tracking-[0.12em] opacity-55">
        sources
      </span>
      {unique.map((s, i) => (
        <a
          key={s.url}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${labelOf(s)} · ${domainOf(s.url)}`}
          aria-label={`Source ${i + 1}: ${labelOf(s)}`}
          className="leading-[15px] text-muted underline decoration-hairline underline-offset-2 transition-colors hover:text-foreground"
        >
          [{i + 1}]
        </a>
      ))}
    </div>
  );
}

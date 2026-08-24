"use client";

import type { SourceUrlUIPart } from "ai";

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Hairline-bordered footnote block for search sources — text only, no
 * favicons, no card grid. Numbered to match the inline superscripts.
 */
export default function Citations({
  sources,
}: {
  sources: SourceUrlUIPart[];
}) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-hairline px-3 py-2">
      {sources.map((s, i) => (
        <div key={s.sourceId ?? i} className="flex gap-2.5 py-1">
          <span className="shrink-0 font-mono text-[10px] leading-5 text-muted">
            [{i + 1}]
          </span>
          <a
            className="min-w-0 truncate font-mono text-[11px] leading-5 text-muted transition-colors hover:text-foreground"
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {s.title ?? domain(s.url)}
            <span className="opacity-60"> · {domain(s.url)}</span>
          </a>
        </div>
      ))}
    </div>
  );
}

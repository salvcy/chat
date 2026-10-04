"use client";

import { useEffect, useState } from "react";

/**
 * Copy-to-clipboard with its own confirmation. State is shown by swapping
 * the glyph to a check for a beat — no colour, consistent with everything
 * else that has to signal "done".
 */
export default function CopyButton({
  text,
  label = "Copy",
  showLabel = false,
  className = "",
}: {
  text: string;
  label?: string;
  /** Show "Copy" / "Copied" beside the glyph, as a code block header does. */
  showLabel?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard can be blocked (insecure origin, denied permission).
          // Nothing useful to say here — leave the glyph unchanged.
        }
      }}
      className={`flex items-center justify-center rounded-control transition-[background-color,color,transform] duration-150 hover:bg-hover-2 active:scale-[0.94] ${
        showLabel ? "h-7 gap-1.5 px-2 text-[12px] font-medium" : "size-7"
      } ${copied ? "text-foreground" : "text-muted hover:text-foreground"} ${className}`}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3.5 8.5 3 3 6-6.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
          <path d="M10.25 3.75a1.75 1.75 0 0 0-1.5-1H4.5a1.75 1.75 0 0 0-1.75 1.75v4.25c0 .7.41 1.3 1 1.58" />
        </svg>
      )}
      {showLabel && <span>{copied ? "Copied" : "Copy"}</span>}
    </button>
  );
}

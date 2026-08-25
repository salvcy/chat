"use client";

import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";
import RailToggle from "@/components/sidebar/RailToggle";
import { formatCost, formatTokens } from "@/lib/format";
import { shortModelId } from "@/lib/capabilities";

type KeyStatus = {
  usage: number | null;
  limit: number | null;
  remaining: number | null;
  freeTier: boolean;
};

/**
 * Context bar: where am I, what is tuned, and what has this thread used?
 *
 * The previous strip led with the model and left the rest of the header
 * empty. This one treats the conversation as the primary context and the
 * model as an adjustable instrument beside it.
 */
export default function StatusStrip({
  title,
  model,
  ready,
  threadCostUsd,
  threadTokens,
  onOpenPalette,
  onOpenSidebar,
}: {
  title?: string;
  model: string;
  ready: boolean;
  threadCostUsd: number | undefined;
  threadTokens: number | undefined;
  onOpenPalette: () => void;
  onOpenSidebar: () => void;
}) {
  const [key, setKey] = useState<KeyStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/key", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: KeyStatus) => setKey(data))
      .catch(() => {
        // The rest of the bar remains useful without the account reading.
      });
    return () => controller.abort();
    // Refresh after a completed turn changes the thread cost.
  }, [threadCostUsd]);

  const credit =
    key?.remaining !== null && key?.remaining !== undefined
      ? `${formatCost(key.remaining)} left`
      : key?.usage !== null && key?.usage !== undefined
        ? `${formatCost(key.usage)} spent`
        : null;

  return (
    <header className="flex h-[58px] shrink-0 items-center gap-2 border-b border-hairline px-3 sm:px-4">
      <RailToggle />
      <button
        onClick={onOpenSidebar}
        aria-label="Conversations"
        className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-foreground md:hidden"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
        </svg>
      </button>

      <div className="flex min-w-0 items-center gap-2.5">
        <button
          onClick={onOpenPalette}
          title="Change model (⌘K)"
          className="group flex min-w-0 items-center gap-2 rounded-full border border-hairline bg-surface px-2.5 py-1.5 font-mono text-[10px] text-secondary transition-colors hover:border-hairline-strong hover:text-foreground"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/55" />
          <span className="max-w-40 truncate">
            {ready ? shortModelId(model) : ""}
          </span>
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 shrink-0 text-muted transition-transform group-hover:translate-y-px" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
          </svg>
        </button>

        <span className="hidden h-4 w-px bg-hairline sm:block" />
        <p className="hidden max-w-[32vw] truncate text-[12px] text-secondary sm:block">
          {title || "New conversation"}
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {(threadCostUsd || threadTokens) && (
          <div className="hidden items-center gap-2 rounded-full border border-hairline px-2.5 py-1.5 font-mono text-[9px] text-muted md:flex">
            {threadCostUsd ? <span>{formatCost(threadCostUsd)}</span> : null}
            {threadCostUsd && threadTokens ? <span className="opacity-40">·</span> : null}
            {threadTokens ? <span>{formatTokens(threadTokens)} tok</span> : null}
          </div>
        )}
        {credit && (
          <span
            className="hidden px-1.5 font-mono text-[9px] text-muted lg:block"
            title="OpenRouter account usage"
          >
            {credit}
          </span>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}

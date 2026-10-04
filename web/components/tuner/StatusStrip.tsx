"use client";

import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";
import RailToggle from "@/components/sidebar/RailToggle";
import { formatCost, formatTokens } from "@/lib/format";
import { shortModelId } from "@/lib/capabilities";
import { fetchKeyStatus, type KeyStatus } from "@/lib/account";

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
  apiKey,
  threadCostUsd,
  threadTokens,
  onOpenPalette,
  onOpenSidebar,
  onNewChat,
  onRailCollapse,
  onTheme,
}: {
  title?: string;
  model: string;
  ready: boolean;
  /** The connected OpenRouter key; null before one is connected. */
  apiKey: string | null;
  threadCostUsd: number | undefined;
  threadTokens: number | undefined;
  onOpenPalette: () => void;
  onOpenSidebar: () => void;
  /** Phones have no rail on screen, so the header carries "new chat". */
  onNewChat: () => void;
  /** Rail collapse travels with the account, so it is persisted upward. */
  onRailCollapse: (collapsed: boolean) => void;
  /** So does the theme. */
  onTheme: (theme: "light" | "dark") => void;
}) {
  /**
   * Tagged with the key it describes. Disconnecting must not leave the
   * previous account's balance on screen, and clearing it from an effect
   * would cascade a render — so the reading is matched to the current key
   * on read instead.
   */
  const [status, setStatus] = useState<{ key: string; value: KeyStatus } | null>(
    null,
  );

  useEffect(() => {
    if (!apiKey) return;
    const controller = new AbortController();
    fetchKeyStatus(apiKey, controller.signal)
      .then((value) => setStatus({ key: apiKey, value }))
      .catch(() => {
        // The rest of the bar remains useful without the account reading.
      });
    return () => controller.abort();
    // Refresh after a completed turn changes the thread cost.
  }, [apiKey, threadCostUsd]);

  const key = apiKey && status?.key === apiKey ? status.value : null;

  const credit =
    key?.remaining !== null && key?.remaining !== undefined
      ? `${formatCost(key.remaining)} left`
      : key?.usage !== null && key?.usage !== undefined
        ? `${formatCost(key.usage)} spent`
        : null;

  return (
    <header
      className="dial-strip flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 sm:px-2.5"
      data-tauri-drag-region="deep"
    >
      <RailToggle onCommit={onRailCollapse} />
      <button
        onClick={onOpenSidebar}
        aria-label="Conversations"
        className="flex size-8 items-center justify-center rounded-control text-muted transition-colors hover:bg-hover-2 hover:text-foreground md:hidden"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
        </svg>
      </button>

      <div className="flex min-w-0 items-center gap-1.5">
        <button
          onClick={onOpenPalette}
          title="Change model (⌘K)"
          className="group flex h-8 min-w-0 items-center gap-2 rounded-control px-2 font-mono text-[12px] text-secondary transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.98]"
        >
          <span aria-hidden className="relative flex size-2 shrink-0 items-center justify-center">
            <span className="absolute size-2 rounded-full bg-foreground/15" />
            <span className="size-1 rounded-full bg-foreground/80" />
          </span>
          <span className="max-w-44 truncate">
            {ready ? shortModelId(model) : ""}
          </span>
          <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-muted transition-transform duration-200 group-hover:translate-y-px" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
          </svg>
        </button>

        <span className="hidden h-4 w-px shrink-0 bg-line sm:block" />
        <p className="hidden min-w-0 max-w-[36vw] truncate px-1.5 text-[13px] text-secondary sm:block">
          {title || "New conversation"}
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {Boolean(threadCostUsd || threadTokens) && (
          <div
            className="hidden items-center gap-1.5 px-2 font-mono text-[11px] tabular-nums text-muted md:flex"
            title="This conversation's total cost and tokens"
          >
            {threadCostUsd ? <span>{formatCost(threadCostUsd)}</span> : null}
            {threadCostUsd && threadTokens ? <span className="opacity-40">·</span> : null}
            {threadTokens ? <span>{formatTokens(threadTokens)} tok</span> : null}
          </div>
        )}
        {credit && (
          <span
            className="hidden rounded-full bg-hover px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-muted lg:block"
            title="OpenRouter account usage"
          >
            {credit}
          </span>
        )}
        <button
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="flex size-8 items-center justify-center rounded-control text-muted transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.96] md:hidden"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11.2 2.8a1.7 1.7 0 0 1 2.4 2.4L7.4 11.4l-3.1.8.8-3.1Z" />
            <path d="M13 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.5" />
          </svg>
        </button>
        <ThemeToggle onCommit={onTheme} />
      </div>
    </header>
  );
}

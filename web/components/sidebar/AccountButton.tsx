"use client";

import type { SessionUser } from "@/lib/auth-client";
import type { SyncStatus } from "@/lib/session";

/**
 * The rail's footer: who you are, whether your history is in step with the
 * account, and the way into settings.
 *
 * It sits below the scrolling list as a `shrink-0` sibling, so the list can
 * scroll without carrying the footer with it. No rule above it: the list
 * fades out where there is more below, which is the edge.
 */
export default function AccountButton({
  user,
  status,
  onOpen,
}: {
  user: SessionUser | null;
  status: SyncStatus;
  onOpen: () => void;
}) {
  const initial = (user?.name || user?.email || "?").trim().charAt(0).toUpperCase();
  const syncing = status.state === "syncing";
  const failed = status.state === "error";

  return (
    <div className="shrink-0 pt-1">
      <button
        onClick={onOpen}
        title={user ? "Account and settings" : "Sign in"}
        className="group flex h-11 w-full items-center gap-2.5 rounded-control px-2 text-left transition-[background-color,transform] duration-150 hover:bg-hover-2 active:scale-[0.99]"
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-[11.5px] font-semibold text-background"
        >
          {user ? initial : "+"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-tight text-foreground">
            {user ? user.name || user.email : "Sign in"}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] leading-tight text-muted">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${
                failed
                  ? "border border-foreground"
                  : syncing
                    ? "bg-muted"
                    : "bg-foreground/70"
              }`}
              style={
                syncing
                  ? { animation: "dial-breathe 1.1s ease-in-out infinite" }
                  : undefined
              }
            />
            {user
              ? syncing
                ? "syncing"
                : failed
                  ? "sync failed"
                  : "synced"
              : "sign in required"}
          </span>
        </span>

        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="h-4 w-4 shrink-0 text-muted transition-[color,transform] duration-300 group-hover:rotate-45 group-hover:text-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="8" cy="8" r="2.1" />
          <path d="M8 1.8v1.6M8 12.6v1.6M13.4 8h-1.6M4.2 8H2.6M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1M11.8 11.8l-1.1-1.1M5.3 5.3 4.2 4.2" />
        </svg>
      </button>
    </div>
  );
}

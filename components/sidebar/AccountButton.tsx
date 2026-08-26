"use client";

import type { SessionUser } from "@/lib/auth-client";
import type { SyncStatus } from "@/lib/session";

/**
 * The rail's footer: who you are, and the way into settings.
 *
 * It sits below the scrolling list as a `shrink-0` sibling for the same
 * reason the header does — the aside owns the rounded border, so anything
 * that scrolls has to be strictly between them or the scrollbar track runs
 * into the corners.
 *
 * Signed out, this is the only prompt to sign in anywhere in the app. That is
 * deliberate: the app works without an account, so the invitation belongs
 * somewhere quiet and permanent rather than in front of the transcript.
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

  return (
    <div className="shrink-0 border-t border-hairline bg-panel p-1.5">
      <button
        onClick={onOpen}
        title={user ? "Account and settings" : "Sign in"}
        className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface"
      >
        <span
          aria-hidden
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${
            user
              ? "bg-invert-fill text-invert-text"
              : "border border-hairline text-muted"
          }`}
        >
          {user ? initial : "+"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] leading-tight text-foreground">
            {user ? user.name || user.email : "Sign in"}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9px] leading-tight text-muted">
            {user
              ? status.state === "syncing"
                ? "syncing…"
                : status.state === "error"
                  ? "sync failed"
                  : "synced"
              : "saved on this device only"}
          </span>
        </span>

        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-muted transition-colors group-hover:text-foreground"
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

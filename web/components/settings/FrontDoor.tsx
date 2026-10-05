"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import BrandMark from "@/components/ui/BrandMark";
import ThemeToggle from "@/components/tuner/ThemeToggle";

/**
 * Everything in front of the app: sign in, unlock, connect a key, and the
 * moment in between while the session resolves.
 *
 * These used to render inside the full shell, beside an empty rail offering
 * "new chat" and a status strip with no conversation in it — controls that
 * did nothing until the gate was passed. The gate is the whole page now,
 * because until it is passed there is no app to show.
 *
 * The page scrolls on its own: `body` is `overflow: hidden` for the chat
 * shell, and a sign-up form on a phone with the keyboard up is taller than
 * the viewport.
 */
export default function FrontDoor({
  children,
  footer,
  onTheme,
}: {
  children: ReactNode;
  /** Extra footer content — "signed in as …, sign out" on the inner gates. */
  footer?: ReactNode;
  onTheme?: (theme: "light" | "dark") => void;
}) {
  return (
    <div className="app-shell flex h-[100dvh] flex-col overflow-y-auto">
      <header
        className="dial-door-bar flex h-14 shrink-0 items-center justify-between px-4 sm:px-6"
        data-tauri-drag-region="deep"
      >
        <BrandMark className="dial-brand" />
        <ThemeToggle onCommit={onTheme ?? (() => {})} />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-6">
        {children}
      </main>

      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 pb-5 text-[11.5px] text-muted">
        {footer}
        {footer && <span className="opacity-40">·</span>}
        <span>End-to-end encrypted</span>
        <span className="opacity-40">·</span>
        <Link href="/privacy" className="transition-colors hover:text-foreground">
          <span className="dial-underline">Privacy</span>
        </Link>
      </footer>
    </div>
  );
}

/** The card every gate sits in. */
export function GateCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`w-full max-w-[380px] rounded-window bg-panel p-6 shadow-overlay sm:p-7 ${className}`}
      style={{ animation: "dial-pop-in 220ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {children}
    </div>
  );
}

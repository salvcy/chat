"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Theme toggle — swaps instantly. No cross-fade: a colour transition on the
 * one control that switches the palette would undercut "no colour, ever"
 * everywhere else.
 *
 * The choice travels with the account, so it is reported upward rather than
 * written here; `lib/session.ts` persists it to the sealed blob and mirrors
 * it to `dial:appearance` for the pre-paint script. It used to write
 * `dial:theme` directly, which quietly disagreed with the `theme` field the
 * settings panel wrote — two keys for one preference, and whichever ran last
 * won.
 *
 * Also listens for `dial:toggle-theme` so the command palette can drive it
 * without lifting theme state into the shell.
 */
export default function ThemeToggle({
  onCommit,
}: {
  onCommit: (theme: "light" | "dark") => void;
}) {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    queueMicrotask(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
  }, []);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    const next = !root.classList.contains("dark");
    setDark(next);

    // Kill transitions for one frame so the swap is genuinely instant.
    const style = document.createElement("style");
    style.appendChild(
      document.createTextNode(
        "*{transition:none!important;animation-duration:0s!important}",
      ),
    );
    document.head.appendChild(style);
    root.classList.toggle("dark", next);
    root.dataset.themeChoice = next ? "dark" : "light";
    onCommit(next ? "dark" : "light");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => style.remove());
    });
  }, [onCommit]);

  useEffect(() => {
    const handler = () => toggle();
    document.addEventListener("dial:toggle-theme", handler);
    return () => document.removeEventListener("dial:toggle-theme", handler);
  }, [toggle]);

  return (
    <button
      className="flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.96]"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      {dark ? (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="3.25" />
          <path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z" />
        </svg>
      )}
    </button>
  );
}

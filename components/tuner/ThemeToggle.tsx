"use client";

import { useEffect, useState } from "react";

const KEY = "dial:theme";

/**
 * Theme toggle — swaps instantly (no cross-fade: a color transition on
 * the control that switches the palette would undercut "no color, ever"
 * everywhere else). Persisted; boot script in layout.tsx applies it
 * before paint so there's no flash.
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    queueMicrotask(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    const root = document.documentElement;
    // Kill all transitions for one frame so the swap is truly instant.
    const style = document.createElement("style");
    style.appendChild(
      document.createTextNode(
        "*{transition:none!important;animation-duration:0s!important}",
      ),
    );
    document.head.appendChild(style);
    root.classList.toggle("dark", next);
    localStorage.setItem(KEY, next ? "dark" : "light");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => style.remove());
    });
  };

  return (
    <button
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-background/40 hover:text-foreground"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
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

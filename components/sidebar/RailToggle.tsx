"use client";

import { useCallback, useEffect, useState } from "react";
import { applyRail, readRail, writeRail } from "@/lib/preferences";

/**
 * Collapse / restore the conversation rail (⌘B).
 *
 * State lives on the document (a class the boot script can set before
 * paint); this only mirrors it for the icon, read after mount so there's no
 * hydration mismatch — the same approach ThemeToggle uses for the palette.
 */
export default function RailToggle() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setCollapsed(
        document.documentElement.classList.contains("dial-rail-collapsed"),
      );
    });
  }, []);

  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains(
      "dial-rail-collapsed",
    );
    const state = { ...readRail(), collapsed: next };
    applyRail(state);
    writeRail(state);
    setCollapsed(next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <button
      onClick={toggle}
      title={collapsed ? "Show conversations (⌘B)" : "Hide conversations (⌘B)"}
      aria-label={collapsed ? "Show conversations" : "Hide conversations"}
      className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-strong hover:text-foreground md:flex"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M6.25 3v10" />
        {/* Filled leaf when open, hollow when collapsed — inversion, not colour. */}
        {!collapsed && <path d="M4.15 3h2.1v10h-2.1z" fill="currentColor" stroke="none" opacity="0.55" />}
      </svg>
    </button>
  );
}

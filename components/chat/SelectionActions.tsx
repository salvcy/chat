"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

type Anchor = { text: string; x: number; y: number; below: boolean };

/**
 * A small bar that appears over a selection inside an answer: quote it into
 * the composer, or copy it.
 *
 * After Beautiful UI's SelectionActions (beautifului.dev, MIT), cut down to
 * the two actions that need no model call. Quoting is the useful one — the
 * usual follow-up to a long answer is a question about one sentence of it,
 * and retyping or pasting that sentence is friction.
 *
 * Scoped deliberately: only a selection wholly inside one assistant message
 * gets the bar (`data-selectable="assistant"`). A range spanning messages is
 * almost always a copy, and the browser already handles that. Waits for the
 * pointer to come up, so the bar does not chase a drag in progress, and stays
 * off touch screens, whose own selection menu would sit underneath it.
 */
export default function SelectionActions({
  containerRef,
  onQuote,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [copied, setCopied] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    let frame = 0;

    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (dragging.current) return;
        const selection = window.getSelection();
        const container = containerRef.current;
        if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) {
          setAnchor(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const element = node instanceof Element ? node : node.parentElement;
        if (
          !element ||
          !container.contains(element) ||
          !element.closest('[data-selectable="assistant"]')
        ) {
          setAnchor(null);
          return;
        }
        const text = selection.toString().trim();
        const rect = range.getBoundingClientRect();
        if (!text || (rect.width === 0 && rect.height === 0)) {
          setAnchor(null);
          return;
        }
        // Flip below the selection when there is no room above it.
        const below = rect.top < 96;
        setCopied(false);
        setAnchor({
          text,
          x: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90),
          y: below ? rect.bottom + 8 : rect.top - 8,
          below,
        });
      });
    };

    const down = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest("[data-selection-actions]")) return;
      dragging.current = true;
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      read();
    };

    document.addEventListener("selectionchange", read);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    window.addEventListener("scroll", read, true);
    window.addEventListener("resize", read);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", read);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      window.removeEventListener("scroll", read, true);
      window.removeEventListener("resize", read);
    };
  }, [containerRef]);

  if (!anchor) return null;

  const action =
    "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-secondary transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.96]";

  return (
    <div
      data-selection-actions
      role="toolbar"
      aria-label="Selection"
      // Keep the selection alive through the click.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-40 flex h-9 items-center gap-0.5 rounded-full bg-panel p-1 shadow-overlay"
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: `translate(-50%, ${anchor.below ? "0" : "-100%"})`,
      }}
    >
      <div
        className="flex items-center gap-0.5"
        style={{
          animation: "dial-pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
          transformOrigin: anchor.below ? "top center" : "bottom center",
        }}
      >
        <button
          type="button"
          className={action}
          onClick={() => {
            onQuote(anchor.text);
            window.getSelection()?.removeAllRanges();
            setAnchor(null);
          }}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
            <path d="M3 9.5C3 7 4.3 5.2 6.6 4.3l.5 1c-1.2.6-1.9 1.4-2 2.5H6.5V11.5H3Zm6 0C9 7 10.3 5.2 12.6 4.3l.5 1c-1.2.6-1.9 1.4-2 2.5h1.4V11.5H9Z" />
          </svg>
          Quote
        </button>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
        <button
          type="button"
          className={action}
          onClick={() => {
            void navigator.clipboard
              .writeText(anchor.text)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m3.5 8.5 3 3 6-6.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
              <path d="M10.25 3.75a1.75 1.75 0 0 0-1.5-1H4.5a1.75 1.75 0 0 0-1.75 1.75v4.25c0 .7.41 1.3 1 1.58" />
            </svg>
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

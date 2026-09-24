"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

const GLIDE =
  "transform 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease";

/**
 * One highlight that glides between rows, instead of every row painting its
 * own hover.
 *
 * Adapted from Beautiful UI's GlideMenu (beautifului.dev, MIT, © 2026 Shane
 * Levine). The difference is where the geometry goes: the original keeps the
 * highlight box in React state, and here it is written straight to the DOM.
 * The rail can hold hundreds of rows, and a pointer moving across it must not
 * re-render any of them — the same reason rail width is a custom property.
 *
 * Two modes:
 *  - `hover` follows the pointer and keyboard focus, and fades out on leave.
 *  - `active` follows whichever row carries `data-glide-active="true"`, which
 *    is how the palette's arrow-key cursor gets the same motion as a mouse.
 */
export default function GlideMenu({
  children,
  className = "",
  highlightClassName = "inset-x-0 rounded-control bg-hover",
  rowSelector = "[data-glide-row]",
  mode = "hover",
  activeKey,
}: {
  children: ReactNode;
  className?: string;
  highlightClassName?: string;
  rowSelector?: string;
  mode?: "hover" | "active";
  /** In `active` mode, changes whenever the active row does. */
  activeKey?: string | number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);

  const place = (row: Element | null) => {
    const box = ref.current;
    const mark = markRef.current;
    if (!box || !mark) return;
    if (!(row instanceof HTMLElement) || !box.contains(row)) {
      mark.style.opacity = "0";
      mark.dataset.shown = "";
      return;
    }
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const height = row.offsetHeight;
    // Appearing from nothing should not slide in from wherever it last was:
    // place it without a transition, then fade.
    if (mark.dataset.shown !== "1") {
      mark.style.transition = "opacity 150ms ease";
      mark.style.transform = `translateY(${top}px)`;
      mark.style.height = `${height}px`;
      void mark.offsetHeight;
      mark.style.transition = GLIDE;
    } else {
      mark.style.transform = `translateY(${top}px)`;
      mark.style.height = `${height}px`;
    }
    mark.style.opacity = "1";
    mark.dataset.shown = "1";
  };

  /*
   * Only rows this menu owns. A row menu opened inside the rail is itself a
   * GlideMenu nested in the rail's, and pointer events bubble: without this
   * check the rail's highlight followed the pointer into the popover and
   * slid behind it to the hovered item's height — two highlights, one on top
   * of the other. Anything inside a nested menu hides this one instead.
   */
  const moveTo = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const row = target.closest(rowSelector);
    place(row && row.closest("[data-glide-menu]") === ref.current ? row : null);
  };

  useLayoutEffect(() => {
    if (mode !== "active") return;
    place(
      activeKey === null || activeKey === undefined
        ? null
        : ([...(ref.current?.querySelectorAll('[data-glide-active="true"]') ?? [])].find(
            (row) => row.closest("[data-glide-menu]") === ref.current,
          ) ?? null),
    );
  }, [mode, activeKey]);

  const hover = mode === "hover";

  return (
    <div
      ref={ref}
      onMouseOver={hover ? (event) => moveTo(event.target) : undefined}
      onMouseLeave={hover ? () => place(null) : undefined}
      onFocusCapture={hover ? (event) => moveTo(event.target) : undefined}
      onBlurCapture={
        hover
          ? (event) => {
              if (!ref.current?.contains(event.relatedTarget as Node | null)) {
                place(null);
              }
            }
          : undefined
      }
      data-glide-menu=""
      className={`relative ${className}`}
    >
      <span
        ref={markRef}
        aria-hidden
        className={`pointer-events-none absolute top-0 ${highlightClassName}`}
        style={{
          opacity: 0,
          height: 0,
          transition: GLIDE,
        }}
      />
      {children}
    </div>
  );
}

"use client";

import { useRef } from "react";
import { RAIL_MAX, RAIL_MIN } from "@/lib/settings";

function clampRail(w: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)));
}

/**
 * The rail's resize edge.
 *
 * Dragging writes `--dial-rail-w` straight onto the document instead of
 * going through React state — a width in state would re-render the whole
 * conversation list on every pointer move. The final value is reported once,
 * on release, and the account persists it: rail geometry travels with the
 * user now rather than being stranded on the device it was dragged on.
 */
export default function RailHandle({
  onCommit,
}: {
  onCommit: (width: number) => void;
}) {
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const root = document.documentElement;
    // Suppress text selection and cursor flicker for the whole drag.
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      root.style.setProperty("--dial-rail-w", `${clampRail(ev.clientX)}px`);
    };

    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = "";
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      const width = Number.parseInt(
        getComputedStyle(root).getPropertyValue("--dial-rail-w"),
        10,
      );
      if (Number.isFinite(width)) onCommit(clampRail(width));
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  /** Keyboard resizing, so the handle isn't pointer-only. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const root = document.documentElement;
    const current =
      Number.parseInt(
        getComputedStyle(root).getPropertyValue("--dial-rail-w"),
        10,
      ) || 272;
    const next = clampRail(current + (e.key === "ArrowRight" ? step : -step));
    root.style.setProperty("--dial-rail-w", `${next}px`);
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize conversation rail"
      aria-valuemin={RAIL_MIN}
      aria-valuemax={RAIL_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        // Double-click snaps back to the default width.
        document.documentElement.style.setProperty("--dial-rail-w", "272px");
        onCommit(272);
      }}
      title="Drag to resize · double-click to reset"
      className="group absolute inset-y-0 right-0 z-20 w-1.5 translate-x-1/2 cursor-col-resize"
    >
      {/* The visible affordance is a hairline that brightens on hover — the
          hit area is deliberately wider than the line it draws. */}
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-hairline group-focus-visible:bg-muted" />
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import type { OceanEngine } from "@/lib/ocean/engine";

/**
 * The ASCII ocean (`lib/ocean`): sharks hunting schools of fish, behind the
 * front door's card and the empty chat's greeting.
 *
 * The canvas is transparent and decorative — the surface it sits on is the
 * water, it takes no pointer events (the engine listens on the window, so
 * fish still scatter from the cursor and a click still splashes), and it is
 * hidden from assistive tech. The theme is read off `<html>` with an observer
 * rather than through React, the same way every other appearance value
 * reaches the page: a toggle repaints the water without re-rendering
 * anything. Glyphs take the canvas's own font, hence `font-mono`.
 *
 * The engine is fetched when an ocean first mounts, not with the page: it
 * was ~15KB gzipped in the eager bundle, paid on every load including the
 * ones that open straight onto a conversation and never show it. The canvas
 * fades in over most of a second anyway, which covers the request.
 */
export default function Ocean({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const root = document.documentElement;
    const isDark = () => root.classList.contains("dark");
    let engine: OceanEngine | null = null;
    let theme: MutationObserver | null = null;
    let gone = false;
    import("@/lib/ocean/engine")
      .then(({ OceanEngine }) => {
        if (gone) return;
        const ocean = new OceanEngine(canvas, { dark: isDark() });
        engine = ocean;
        theme = new MutationObserver(() => ocean.setTheme(isDark()));
        theme.observe(root, { attributes: true, attributeFilter: ["class"] });
      })
      // Decoration: if the chunk cannot load (a deploy replaced it under an
      // old page, or the network went), the water simply stays empty.
      .catch(() => {});
    return () => {
      gone = true;
      theme?.disconnect();
      engine?.destroy();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`dial-ocean pointer-events-none block font-mono ${className}`}
    />
  );
}

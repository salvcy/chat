"use client";

import { useEffect, useRef } from "react";
import type { OceanEngine } from "@/lib/ocean/engine";
import type { SharkSpec } from "@/lib/ocean/world";
import { DEFAULT_OCEAN_PLACES, type OceanPlace } from "@/lib/settings";

/**
 * The ASCII ocean (`lib/ocean`): sharks hunting schools of fish, behind the
 * front door's gates and the chat.
 *
 * Every ocean has a place, and swims only where the person has said it may:
 * `data-ocean` on the root lists the places (Settings → Appearance), set
 * pre-paint by the boot script and afterwards by `applyAppearance`, so the
 * sign-in screen knows before anyone has signed in. The component watches
 * that attribute and the theme class with one observer rather than through
 * React — the same way every other appearance value reaches the page — and
 * starts, fades out or repaints without re-rendering anything. A place that
 * is off never loads the engine; one turned off fades and then lets the
 * engine and its canvas memory go. `preview` (the settings card) always
 * swims.
 *
 * The canvas is transparent and decorative — the surface it sits on is the
 * water, it takes no pointer events (the engine listens on the window, so
 * fish still scatter from the cursor and a click still splashes), and it is
 * hidden from assistive tech. Glyphs take the canvas's own font, hence
 * `font-mono`.
 *
 * The engine is a lazy chunk (~11KB gzipped), fetched the first time an
 * ocean is wanted rather than with the page.
 */
export default function Ocean({
  place,
  className = "",
  sharks,
  fishCount,
}: {
  place: OceanPlace | "preview";
  className?: string;
  /** Who swims, and how many fish — read once; the settings preview is smaller. */
  sharks?: SharkSpec[];
  fishCount?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cast = useRef({ sharks, fishCount });
  const placeRef = useRef(place);
  const syncRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const root = document.documentElement;
    const isDark = () => root.classList.contains("dark");
    const wanted = () => {
      const here = placeRef.current;
      if (here === "preview") return true;
      const attr = root.dataset.ocean;
      const places = attr === undefined ? DEFAULT_OCEAN_PLACES : attr.split(" ");
      return (places as readonly string[]).includes(here);
    };

    let engine: OceanEngine | null = null;
    let loading = false;
    let gone = false;
    let stopping: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      clearTimeout(stopping);
      canvas.dataset.live = "";
      if (engine || loading) return;
      loading = true;
      import("@/lib/ocean/engine")
        .then(({ OceanEngine }) => {
          loading = false;
          if (gone || !wanted() || engine) return;
          engine = new OceanEngine(canvas, { ...cast.current, dark: isDark() });
        })
        // Decoration: if the chunk cannot load (a deploy replaced it under
        // an old page, or the network went), the water simply stays empty.
        .catch(() => {
          loading = false;
        });
    };

    // Fade, then let the engine and its backing store go.
    const stop = () => {
      delete canvas.dataset.live;
      clearTimeout(stopping);
      stopping = setTimeout(() => {
        engine?.destroy();
        engine = null;
      }, 450);
    };

    const sync = () => {
      if (wanted()) start();
      else stop();
      engine?.setTheme(isDark());
    };
    syncRef.current = sync;

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-ocean"] });
    sync();
    return () => {
      gone = true;
      observer.disconnect();
      clearTimeout(stopping);
      engine?.destroy();
    };
  }, []);

  // A moved ocean (new chat → conversation, sign-in → unlock) keeps its
  // engine when the new place is on, and fades when it is not.
  useEffect(() => {
    placeRef.current = place;
    syncRef.current();
  }, [place]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`dial-ocean pointer-events-none block font-mono ${className}`}
    />
  );
}

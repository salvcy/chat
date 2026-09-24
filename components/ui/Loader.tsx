"use client";

import { useEffect, useState } from "react";

/*
 * The pixel-grid loader, adapted from Beautiful UI's LoadingState
 * (beautifului.dev, MIT, © 2026 Shane Levine).
 *
 * A 3×3 grid of 4px cells brightening along a chevron, so a wavefront drives
 * left to right. The 650ms cycle is shorter than the sweep, which keeps two
 * fronts in flight and stops it reading as a blink. Monochrome by
 * construction: the cells are the foreground colour at varying opacity.
 */
const CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const col = i % 3;
  return (col + Math.abs(row - 1)) * 90;
});

export function PixelGrid({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px] ${className}`}
    >
      {CHEVRON.map((delay, index) => (
        <span
          key={index}
          className="size-[4px] rounded-[1px] bg-foreground"
          style={{
            opacity: 0.15,
            animation: `dial-pixel 650ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function format(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(0).padStart(2, "0")}s`;
}

/**
 * A live elapsed readout — mono, tabular, measured.
 *
 * `since` anchors it to a real start time (a message's `startedAt`), so a
 * remount mid-answer resumes the count instead of restarting it at zero.
 */
export function Elapsed({
  since,
  className = "",
}: {
  since?: number;
  className?: string;
}) {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(start);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, []);

  return (
    <span className={`font-mono text-[11px] tabular-nums text-muted ${className}`}>
      {format(now - (since ?? start))}
    </span>
  );
}

/** Grid, shimmering label, elapsed time — for work with no progress to show. */
export default function Loader({
  label,
  since,
  timer = true,
  className = "",
}: {
  label?: string;
  since?: number;
  timer?: boolean;
  className?: string;
}) {
  return (
    <div role="status" className={`flex w-fit items-center gap-2.5 ${className}`}>
      <PixelGrid />
      {label && (
        <span className="dial-shimmer text-[13px] font-medium">{label}</span>
      )}
      {timer && <Elapsed since={since} />}
    </div>
  );
}

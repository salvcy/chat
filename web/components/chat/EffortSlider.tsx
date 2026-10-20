"use client";

import { useRef, type CSSProperties } from "react";
import type { ReasoningEffort } from "@/lib/types";

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};

export const EFFORT_DESCRIPTION: Record<ReasoningEffort, string> = {
  off: "Answers straight away, without thinking first.",
  minimal: "A quick check before answering.",
  low: "Thinks briefly. Fast and inexpensive.",
  medium: "A balance of depth and speed.",
  high: "Thinks longer on hard problems.",
  xhigh: "As deep as this model goes. Slowest and costliest.",
};

/** Inset of the thumb from the track's edge, and the thumb's side, in px. */
const INSET = 3;
const THUMB = 30;

/**
 * How hard the model thinks, as a stepped slider — exactly the model's
 * efforts, low to high, with a detent at each.
 *
 * Effort is a scale, so it is drawn as one: a squircle track whose quiet fill
 * runs up to the thumb, a small square at every stop, and the thumb itself
 * as the one inverted mark — the same "on" the send button uses. It moves in
 * steps rather than following the pointer freely: there is nothing between
 * "medium" and "high" to land on, and each step is a settings change that
 * travels to the account, so dragging across four levels makes four, not
 * four hundred. The thumb glides between detents, which is what makes the
 * steps feel like a dial rather than a jump.
 *
 * A real slider for assistive tech and the keyboard: arrows step, Home and
 * End go to the ends.
 */
export default function EffortSlider({
  value,
  options,
  onChange,
}: {
  value: ReasoningEffort;
  /** Exactly what the model accepts, low→high — `effortOptions(caps)`. */
  options: ReasoningEffort[];
  onChange: (next: ReasoningEffort) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const last = options.length - 1;
  const index = Math.max(0, options.indexOf(value));
  const pos = last > 0 ? index / last : 0;

  const go = (next: number) => {
    const clamped = Math.min(last, Math.max(0, next));
    if (options[clamped] && clamped !== index) onChange(options[clamped]);
  };

  /** The stop nearest the pointer, measured along the thumb's travel. */
  const pick = (clientX: number) => {
    const track = trackRef.current;
    if (!track || last < 1) return;
    const rect = track.getBoundingClientRect();
    const travel = rect.width - INSET * 2 - THUMB;
    const ratio = (clientX - rect.left - INSET - THUMB / 2) / travel;
    go(Math.round(Math.min(1, Math.max(0, ratio)) * last));
  };

  // Geometry the CSS reads: where the thumb sits along its travel.
  const travel = `(100% - ${INSET * 2 + THUMB}px)`;
  const style = { "--pos": pos } as CSSProperties;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={EFFORT_LABEL[options[index] ?? value]}
      style={style}
      className="dial-squircle relative h-9 cursor-pointer touch-none select-none bg-field shadow-field outline-none [--sq:11px] focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-muted"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        pick(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e.clientX);
      }}
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowRight" || e.key === "ArrowUp"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowDown"
              ? -1
              : 0;
        if (step) {
          e.preventDefault();
          go(index + step);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          go(e.key === "Home" ? 0 : last);
        }
      }}
    >
      {/* The quiet fill, from the left edge to the thumb's far side. */}
      <span
        aria-hidden
        className="dial-squircle absolute bottom-[3px] left-[3px] top-[3px] bg-foreground/[0.09] transition-[width] duration-200 ease-out-strong [--sq:9px]"
        style={{ width: `calc(${THUMB}px + ${travel} * var(--pos))` }}
      />

      {options.map((option, i) => (
        <span
          key={option}
          aria-hidden
          className={`absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] transition-colors duration-200 ${
            i <= index ? "bg-foreground/45" : "bg-foreground/20"
          }`}
          style={{
            left: `calc(${INSET + THUMB / 2}px + ${travel} * ${last > 0 ? i / last : 0})`,
          }}
        />
      ))}

      <span
        aria-hidden
        className="dial-squircle absolute top-[3px] flex items-center justify-center bg-invert-fill shadow-btn transition-[left] duration-200 ease-out-strong [--sq:9px]"
        style={{
          left: `calc(${INSET}px + ${travel} * var(--pos))`,
          width: THUMB,
          height: THUMB,
        }}
      >
        <span className="h-2.5 w-px rounded-full bg-invert-text/35" />
      </span>
    </div>
  );
}

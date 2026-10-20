"use client";

import { useRef, type CSSProperties } from "react";

/** Inset of the thumb from the track's edge, and the thumb's side, in px. */
const INSET = 3;

/**
 * A choice along a scale, as a stepped slider with a detent at each option.
 *
 * A squircle track whose quiet fill runs up to the thumb, a small square at
 * every stop, and the thumb itself as the one inverted mark. It moves in
 * steps rather than following the pointer freely: there is nothing between
 * two options to land on, and each step is usually a settings write that
 * travels to the account — dragging across four options makes four, not four
 * hundred. The thumb glides between detents, which is what makes the steps
 * feel like a dial rather than a jump.
 *
 * Used for reasoning effort (EffortSlider), text size and column width. A
 * real slider for assistive tech and the keyboard: arrows step, Home and End
 * go to the ends.
 */
export default function StepSlider<T extends string>({
  value,
  options,
  onChange,
  label,
  valueText,
  size = "md",
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  label: string;
  /** What a screen reader hears for an option. */
  valueText: (option: T) => string;
  size?: "sm" | "md";
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumb = size === "sm" ? 24 : 30;
  const last = options.length - 1;
  const index = Math.max(0, options.indexOf(value));
  const pos = last > 0 ? index / last : 0;

  const go = (next: number) => {
    const clamped = Math.min(last, Math.max(0, next));
    if (options[clamped] !== undefined && clamped !== index) onChange(options[clamped]);
  };

  /** The stop nearest the pointer, measured along the thumb's travel. */
  const pick = (clientX: number) => {
    const track = trackRef.current;
    if (!track || last < 1) return;
    const rect = track.getBoundingClientRect();
    const travel = rect.width - INSET * 2 - thumb;
    const ratio = (clientX - rect.left - INSET - thumb / 2) / travel;
    go(Math.round(Math.min(1, Math.max(0, ratio)) * last));
  };

  const travel = `(100% - ${INSET * 2 + thumb}px)`;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={valueText(options[index] ?? value)}
      style={{ "--pos": pos, height: thumb + INSET * 2 } as CSSProperties}
      className={`dial-squircle relative cursor-pointer touch-none select-none bg-field shadow-field outline-none focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-muted ${
        size === "sm" ? "[--sq:9px]" : "[--sq:11px]"
      }`}
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
        className={`dial-squircle absolute bottom-[3px] left-[3px] top-[3px] bg-foreground/[0.09] transition-[width] duration-200 ease-out-strong ${
          size === "sm" ? "[--sq:7px]" : "[--sq:9px]"
        }`}
        style={{ width: `calc(${thumb}px + ${travel} * var(--pos))` }}
      />

      {options.map((option, i) => (
        <span
          key={option}
          aria-hidden
          className={`absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] transition-colors duration-200 ${
            i <= index ? "bg-foreground/45" : "bg-foreground/20"
          }`}
          style={{
            left: `calc(${INSET + thumb / 2}px + ${travel} * ${last > 0 ? i / last : 0})`,
          }}
        />
      ))}

      <span
        aria-hidden
        className={`dial-squircle absolute top-[3px] flex items-center justify-center bg-invert-fill shadow-btn transition-[left] duration-200 ease-out-strong ${
          size === "sm" ? "[--sq:7px]" : "[--sq:9px]"
        }`}
        style={{
          left: `calc(${INSET}px + ${travel} * var(--pos))`,
          width: thumb,
          height: thumb,
        }}
      >
        <span className={`w-px rounded-full bg-invert-text/35 ${size === "sm" ? "h-2" : "h-2.5"}`} />
      </span>
    </div>
  );
}

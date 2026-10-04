"use client";

import { useRef } from "react";

/**
 * Equal-width segments with a thumb that slides to the selection — Beautiful
 * UI's SegmentedControl (beautifului.dev, MIT). The thumb is a lifted
 * surface, not an inversion: this is a choice among peers, and a filled block
 * would read as "on".
 *
 * A radio group to assistive tech and to the keyboard: arrow keys move the
 * selection and focus together, the way a native radio group does.
 */
export default function Segmented<T extends string>({
  value,
  options,
  onChange,
  labels,
  label,
  className = "",
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  labels?: Partial<Record<T, string>>;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(0, options.indexOf(value));

  const move = (step: number) => {
    const next = Math.min(options.length - 1, Math.max(0, index + step));
    if (next === index) return;
    onChange(options[next]);
    ref.current
      ?.querySelectorAll<HTMLButtonElement>("[role=radio]")
      [next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
      className={`relative grid h-8 select-none rounded-full bg-hover-2 p-0.5 ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-full bg-panel shadow-btn transition-transform duration-200 ease-out-strong"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option)}
            className={`relative z-10 truncate rounded-full px-1.5 text-[12.5px] font-medium capitalize transition-colors duration-150 ${
              active ? "text-foreground" : "text-muted hover:text-secondary"
            }`}
          >
            {labels?.[option] ?? option}
          </button>
        );
      })}
    </div>
  );
}

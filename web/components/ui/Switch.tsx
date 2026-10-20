"use client";

/**
 * An on/off switch, squared off like the composer's controls.
 *
 * A binary switch that is on is an inversion — the filled track — which is
 * the design system's rule for "on", the same as the send button. The knob is
 * a squircle that slides across.
 */
export default function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name, when there is no visible label wired to it. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`dial-squircle relative h-[22px] w-[38px] shrink-0 transition-[background-color,opacity] duration-200 [--sq:8px] disabled:opacity-35 ${
        checked ? "bg-invert-fill" : "bg-hover-2 shadow-field"
      }`}
    >
      <span
        aria-hidden
        className={`dial-squircle absolute left-[3px] top-[3px] size-4 shadow-btn transition-[transform,background-color] duration-200 ease-out-strong [--sq:5px] ${
          checked ? "translate-x-4 bg-invert-text" : "bg-panel"
        }`}
      />
    </button>
  );
}

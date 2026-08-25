"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

export type DropdownOption = {
  value: string;
  label: string;
  hint?: string;
};

/**
 * A minimal glass menu. The trigger shows the current value in mono; the
 * menu floats above the composer and inverts the active row — state by
 * inversion, never colour.
 *
 * `disabled` carries a reason rather than just greying out: when the model
 * can't do a thing, the control says so on hover instead of failing silently.
 */
export default function Dropdown({
  label,
  value,
  options,
  onChange,
  align = "left",
  disabled = false,
  disabledReason,
  activeWhen = (v) => v !== "off",
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  align?: "left" | "right";
  disabled?: boolean;
  disabledReason?: string | null;
  activeWhen?: (v: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Derived, not stored: a model switch can strip the options out from under
  // an open menu, and closing it in an effect would cascade a second render.
  const isOpen = open && !disabled;

  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [isOpen]);

  const active = !disabled && activeWhen(value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={disabled ? (disabledReason ?? `${label} unavailable`) : label}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 font-mono text-[10px] transition-colors ${
          disabled
            ? "cursor-not-allowed text-muted/40 line-through decoration-hairline"
            : active
              ? "bg-invert-fill text-invert-text"
              : "text-muted hover:bg-surface-strong hover:text-foreground"
        }`}
      >
        {label}
        <span className={active ? "opacity-65" : ""}>{disabled ? "n/a" : value}</span>
        {!disabled && (
          <motion.span
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.15 }}
            className="text-[8px] opacity-60"
          >
            ▾
          </motion.span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            role="listbox"
            aria-label={`${label} options`}
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className={`absolute bottom-full z-50 mb-2 min-w-[160px] overflow-hidden rounded-2xl border border-hairline-strong bg-panel/95 p-1 shadow-[0_18px_60px_var(--shadow)] backdrop-blur-[24px] ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left font-mono text-[11px] transition-colors hover:bg-surface-strong ${
                  opt.value === value
                    ? "bg-invert-fill text-invert-text"
                    : "text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                {opt.hint && (
                  <span
                    className={`text-[10px] ${
                      opt.value === value ? "opacity-60" : "text-muted"
                    }`}
                  >
                    {opt.hint}
                  </span>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

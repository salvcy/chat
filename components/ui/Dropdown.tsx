"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * A minimal glass dropdown. The trigger shows the current value in mono;
 * the menu floats above the composer, options invert on the active one.
 */
export default function Dropdown({
  label,
  value,
  options,
  onChange,
  align = "left",
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  onChange: (v: string) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
  }, [open]);

  const active = value !== "off";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] transition-colors ${
          active ? "text-foreground" : "text-muted"
        } hover:text-foreground`}
      >
        {label}{" "}
        <span
          className={
            active
              ? "rounded-full bg-invert-fill px-1.5 py-0.5 text-invert-text"
              : ""
          }
        >
          {value}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.15 }}
          className="text-[8px] opacity-60"
        >
          ▾
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className={`absolute bottom-full z-50 mb-2 min-w-[140px] overflow-hidden rounded-xl border border-hairline bg-background/90 shadow-[0_16px_48px_rgba(0,0,0,0.3)] backdrop-blur-[20px] ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-mono text-[12px] transition-colors hover:bg-surface ${
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

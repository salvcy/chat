"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import GlideMenu from "./GlideMenu";

export type DropdownOption = {
  value: string;
  label: string;
  hint?: string;
};

/**
 * A minimal menu. The trigger is a pill that inverts while the setting is
 * engaged; the menu pops above the composer on the overlay shadow, a single
 * highlight glides between rows, and the chosen row carries a check — state
 * by fill and mark, never colour.
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
  icon,
}: {
  label: string;
  icon?: ReactNode;
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
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
          disabled
            ? "cursor-not-allowed text-muted/40 line-through decoration-hairline"
            : active
              ? // A value selector, not a switch: it is engaged nearly all the
                // time on a reasoning model, and a permanently inverted block
                // would be the loudest thing on screen. A quiet fill instead.
                "bg-hover-2 text-foreground hover:bg-surface-strong"
              : isOpen
                ? "bg-hover-2 text-foreground"
                : "text-secondary hover:bg-hover-2 hover:text-foreground"
        }`}
      >
        {icon}
        {label}
        <span className="text-muted">
          {disabled ? "n/a" : value}
        </span>
        {!disabled && (
          <svg
            viewBox="0 0 12 12"
            className={`h-2.5 w-2.5 transition-transform duration-200 ${isOpen ? "rotate-180" : ""} text-muted`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
          </svg>
        )}
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label={`${label} options`}
          className={`absolute bottom-full z-50 mb-2 min-w-[180px] rounded-card bg-panel p-1 shadow-overlay ${
            align === "right" ? "right-0 origin-bottom-right" : "left-0 origin-bottom-left"
          }`}
          style={{ animation: "dial-pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          <p className="px-2 pb-1 pt-1.5 text-[11.5px] font-medium text-muted">
            {label}
          </p>
          <GlideMenu highlightClassName="inset-x-0 rounded-chip bg-hover-2">
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  data-glide-row
                  aria-selected={selected}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className="relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[13px] text-foreground"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {selected && (
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m3.5 8.5 3 3 6-6.5" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 capitalize">{opt.label}</span>
                  {opt.hint && (
                    <span className="font-mono text-[10.5px] text-muted">{opt.hint}</span>
                  )}
                </button>
              );
            })}
          </GlideMenu>
        </div>
      )}
    </div>
  );
}

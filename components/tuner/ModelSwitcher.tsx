"use client";

import type { OpenRouterModel } from "@/lib/types";
import { formatContext, formatPricePerMillion } from "@/lib/format";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

const MAX_ROWS = 80;

/**
 * The model switcher — a floating glass palette. Every OpenRouter model,
 * searchable, with pricing and context in mono. Selecting a row fires the
 * tuner-tick: a filled block sweeps across and inverts, ~200ms, before the
 * selection commits.
 */
export default function ModelSwitcher({
  models,
  current,
  onSelect,
  onClose,
}: {
  models: OpenRouterModel[];
  current: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return models;
    return models.filter((m) => {
      const hay = `${m.id} ${m.name}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [models, query]);

  const visible = filtered.slice(0, MAX_ROWS);

  const choose = (id: string) => {
    setSettled(id);
    setTimeout(() => onSelect(id), 200);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/50 px-4 pt-24 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline bg-background/80 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-hairline px-4 py-3">
          <input
            ref={inputRef}
            className="w-full bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted"
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && visible.length > 0) choose(visible[0].id);
            }}
          />
        </div>
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {visible.map((m) => {
            const isSettled = m.id === settled;
            const isCurrent = m.id === current && !settled;
            return (
              <button
                key={m.id}
                className={`relative flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface ${
                  isCurrent ? "bg-surface" : ""
                }`}
                onClick={() => choose(m.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {m.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {m.id}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[11px] text-muted">
                  {formatPricePerMillion(m.promptPrice)}/
                  {formatPricePerMillion(m.completionPrice)}
                  {m.contextLength ? ` · ${formatContext(m.contextLength)}` : ""}
                </span>
                {isSettled && (
                  <motion.span
                    className="pointer-events-none absolute inset-0 bg-invert-fill"
                    initial={{ scaleX: 0, opacity: 1 }}
                    animate={{ scaleX: [1, 1.03, 1], opacity: [1, 1, 0] }}
                    transition={{ duration: 0.2, ease: [0.16, 1.4, 0.32, 1], times: [0, 0.65, 1] }}
                    style={{ transformOrigin: "left" }}
                  />
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-xs text-muted">
              no models match “{query}”
            </p>
          )}
          {filtered.length > MAX_ROWS && (
            <p className="py-2 text-center font-mono text-[11px] text-muted">
              {filtered.length - MAX_ROWS} more — keep typing
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}

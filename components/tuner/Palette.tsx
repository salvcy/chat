"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatContext, formatPricePerMillion } from "@/lib/format";
import type { OpenRouterModel } from "@/lib/types";

const MAX_ROWS = 60;
const RECENTS_KEY = "dial:recent-models";
const MAX_RECENTS = 6;
type ModelScope =
  | "all"
  | "reasoning"
  | "web"
  | "vision"
  | "image"
  | "free";

/** An action the palette can run. Supplied by the shell, which owns state. */
export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string) {
  try {
    const next = [id, ...readRecents().filter((x) => x !== id)].slice(
      0,
      MAX_RECENTS,
    );
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / storage disabled — recents are a convenience only.
  }
}

/** Capability chips. An absent capability is an absent chip, never a red X. */
function Chips({ m }: { m: OpenRouterModel }) {
  const chips: string[] = [];
  if (m.capabilities.reasoning) {
    chips.push(m.capabilities.reasoningMandatory ? "always reasons" : "reasons");
  }
  if (m.capabilities.vision) chips.push("vision");
  if (m.capabilities.imageGeneration) chips.push("image");
  if (m.capabilities.tools) chips.push("web");
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c}
          title={
            c === "web"
              ? "Can call this app's web-search tool"
              : c === "vision"
                ? "Accepts images as input"
                : c === "image"
                  ? "Can generate image output"
              : undefined
          }
          className="rounded-full border border-hairline px-1.5 py-px text-[9px] uppercase tracking-wider text-muted"
        >
          {c}
        </span>
      ))}
    </span>
  );
}

/**
 * The palette — the app's one floating surface.
 *
 * ⌘K opens it straight into model mode, because tuning the model is the
 * signature interaction and shouldn't cost an extra keystroke. Typing `>`
 * switches the same surface to commands, so the app has a command palette
 * without a second component or a second shortcut to remember.
 *
 * Selecting a model fires the tuner-tick: a filled block sweeps the row and
 * inverts, ~200ms — the one place motion is allowed to be expressive.
 */
export default function Palette({
  models,
  current,
  commands,
  onSelect,
  onClose,
}: {
  models: OpenRouterModel[];
  current: string;
  commands: Command[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [rawCursor, setCursor] = useState(0);
  const [scope, setScope] = useState<ModelScope>("all");
  const [settled, setSettled] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [recents] = useState(() => readRecents());

  const commandMode = query.startsWith(">");
  const term = (commandMode ? query.slice(1) : query).trim().toLowerCase();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const visibleCommands = useMemo(() => {
    if (!commandMode) return [];
    const tokens = term.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ""}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [commandMode, commands, term]);

  const filteredModels = useMemo(() => {
    if (commandMode) return [];
    const tokens = term.split(/\s+/).filter(Boolean);
    const searched =
      tokens.length === 0
        ? models
        : models.filter((m) => {
            const hay = `${m.id} ${m.name}`.toLowerCase();
            return tokens.every((t) => hay.includes(t));
          });
    const matched = searched.filter((model) => {
      if (scope === "reasoning") return model.capabilities.reasoning;
      if (scope === "web") return model.capabilities.tools;
      if (scope === "vision") return model.capabilities.vision;
      if (scope === "image") return model.capabilities.imageGeneration;
      if (scope === "free") {
        return Number(model.promptPrice) === 0 && Number(model.completionPrice) === 0;
      }
      return true;
    });

    if (tokens.length > 0) return matched;

    // No query: float the current model, then recents, to the top.
    const priority = new Map<string, number>();
    recents.forEach((id, i) => priority.set(id, i + 1));
    priority.set(current, 0);
    return [...matched].sort((a, b) => {
      const pa = priority.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const pb = priority.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return pa === pb ? a.id.localeCompare(b.id) : pa - pb;
    });
  }, [commandMode, models, term, recents, current, scope]);

  const visibleModels = useMemo(
    () => filteredModels.slice(0, MAX_ROWS),
    [filteredModels],
  );

  const rowCount = commandMode ? visibleCommands.length : visibleModels.length;

  // The cursor is clamped on read rather than reset in an effect — a shrinking
  // result list must never leave it pointing past the end.
  const cursor = Math.min(rawCursor, Math.max(rowCount - 1, 0));

  const chooseModel = (id: string) => {
    if (settled) return;
    setSettled(id);
    pushRecent(id);
    setTimeout(() => onSelect(id), 200);
  };

  const runCommand = (c: Command) => {
    onClose();
    c.run();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, rowCount - 1));
      } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (commandMode) {
          const c = visibleCommands[cursor];
          if (c) runCommand(c);
        } else {
          const m = visibleModels[cursor];
          if (m) chooseModel(m.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are recreated with the rows they act on
  }, [rowCount, cursor, commandMode, visibleCommands, visibleModels, settled]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-chrome/70 px-3 pt-[10vh] backdrop-blur-md sm:px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="w-full max-w-[660px] overflow-hidden rounded-[24px] border border-hairline-strong bg-panel/95 shadow-[0_28px_100px_var(--shadow)] backdrop-blur-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 pb-2.5 pt-4 sm:px-5">
          {commandMode && (
            <span className="shrink-0 rounded-md bg-invert-fill px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-invert-text">
              cmd
            </span>
          )}
          <input
            ref={inputRef}
            className="w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted"
            placeholder="Find a model…  (> for commands)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query invalidates wherever the cursor was.
              setCursor(0);
            }}
          />
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {rowCount}
          </span>
        </div>

        {!commandMode && (
          <div className="flex items-center gap-1 border-b border-hairline px-4 pb-3 sm:px-5">
            {(["all", "reasoning", "web", "vision", "image", "free"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-label={
                  item === "web" ? "Show web-capable models" : `Show ${item} models`
                }
                aria-pressed={scope === item}
                onClick={() => {
                  setScope(item);
                  setCursor(0);
                }}
                className={`rounded-full px-2.5 py-1 font-mono text-[9px] transition-colors ${
                  scope === item
                    ? "bg-invert-fill text-invert-text"
                    : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                {item}
              </button>
            ))}
          </div>
        )}

        <div
          ref={listRef}
          className="dial-scroll max-h-[56vh] overflow-y-auto p-1.5"
        >
          {commandMode
            ? visibleCommands.map((c, idx) => (
                <button
                  key={c.id}
                  data-idx={idx}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => runCommand(c)}
                  className={`flex w-full items-baseline justify-between gap-4 rounded-xl px-3.5 py-2.5 text-left transition-colors ${
                    idx === cursor ? "bg-surface-strong" : ""
                  }`}
                >
                  <span className="truncate text-sm text-foreground">
                    {c.label}
                  </span>
                  {c.hint && (
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      {c.hint}
                    </span>
                  )}
                </button>
              ))
            : visibleModels.map((m, idx) => {
                const isSettled = m.id === settled;
                return (
                  <button
                    key={m.id}
                    data-idx={idx}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => chooseModel(m.id)}
                    className={`relative flex w-full items-start justify-between gap-4 overflow-hidden rounded-xl px-3.5 py-2.5 text-left transition-colors ${
                      idx === cursor ? "bg-surface-strong" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm text-foreground">
                          {m.name}
                        </span>
                        {m.id === current && (
                          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted">
                            tuned
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                        {m.id}
                      </span>
                      <span className="mt-1 flex">
                        <Chips m={m} />
                      </span>
                    </span>

                    <span className="shrink-0 pt-0.5 text-right font-mono text-[11px] leading-relaxed text-muted">
                      <span className="block">
                        {formatPricePerMillion(m.promptPrice)}
                        {" / "}
                        {formatPricePerMillion(m.completionPrice)}
                      </span>
                      {m.contextLength && (
                        <span className="block opacity-70">
                          {formatContext(m.contextLength)}
                        </span>
                      )}
                    </span>

                    {isSettled && (
                      <motion.span
                        className="pointer-events-none absolute inset-0 bg-invert-fill"
                        initial={{ scaleX: 0, opacity: 1 }}
                        animate={{ scaleX: [1, 1.03, 1], opacity: [1, 1, 0] }}
                        transition={{
                          duration: 0.2,
                          ease: [0.16, 1.4, 0.32, 1],
                          times: [0, 0.65, 1],
                        }}
                        style={{ transformOrigin: "left" }}
                      />
                    )}
                  </button>
                );
              })}

          {!commandMode && models.length === 0 && (
            <p className="px-4 py-8 text-center font-mono text-xs leading-relaxed text-muted">
              catalog unavailable
              <br />
              <span className="opacity-70">
                check OPENROUTER_API_KEY in .env.local
              </span>
            </p>
          )}
          {rowCount === 0 && (commandMode || models.length > 0) && (
            <p className="px-4 py-6 text-center font-mono text-xs text-muted">
              nothing matches “{term}”
            </p>
          )}
          {!commandMode && filteredModels.length > MAX_ROWS && (
            <p className="py-2 text-center font-mono text-[11px] text-muted">
              {filteredModels.length - MAX_ROWS} more — keep typing
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-hairline px-4 py-2.5 font-mono text-[9px] text-muted sm:px-5">
          <span>↑↓ move</span>
          <span>⏎ {commandMode ? "run" : "tune"}</span>
          <span>&gt; commands</span>
          <span>esc close</span>
        </div>
      </motion.div>
    </div>
  );
}

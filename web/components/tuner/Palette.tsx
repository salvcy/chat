"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import GlideMenu from "@/components/ui/GlideMenu";
import { formatContext, formatPricePerMillion } from "@/lib/format";
import type { OpenRouterModel } from "@/lib/types";

const MAX_ROWS = 60;
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

/**
 * Recently picked models travel with the account rather than the device.
 *
 * The list arrives as a prop and changes are reported back up, the same way
 * the theme and the rail do. Someone who works across a laptop and a phone
 * gets the models they actually use at the top of both.
 */
export function nextRecents(current: readonly string[], id: string): string[] {
  return [id, ...current.filter((x) => x !== id)].slice(0, MAX_RECENTS);
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
          className="rounded-chip px-1.5 py-px font-mono text-[10.5px] text-muted shadow-hairline"
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
  recentModels,
  onRecent,
  onSelect,
  onClose,
}: {
  models: OpenRouterModel[];
  current: string;
  commands: Command[];
  /** Newest first, from the account's settings blob. */
  recentModels: readonly string[];
  onRecent?: (next: string[]) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [rawCursor, setCursor] = useState(0);
  const [scope, setScope] = useState<ModelScope>("all");
  const [settled, setSettled] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recents = recentModels;

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
    onRecent?.(nextRecents(recentModels, id));
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-3 pt-[11vh] backdrop-blur-[2px] sm:px-4"
      onClick={onClose}
      style={{ animation: "dial-fade-in 150ms ease-out both" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={commandMode ? "Commands" : "Choose a model"}
        className="w-full max-w-[640px] overflow-hidden rounded-window bg-panel shadow-overlay"
        style={{
          animation: "dial-pop-in 200ms cubic-bezier(0.23,1,0.32,1) both",
          transformOrigin: "top center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] items-center gap-2.5 px-4">
          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3.25 3.25" />
          </svg>
          {commandMode && (
            <span className="shrink-0 rounded-chip bg-foreground px-1.5 py-0.5 text-[11px] font-medium text-background">
              Commands
            </span>
          )}
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted"
            placeholder={commandMode ? "Run a command…" : "Find a model…"}
            aria-label={commandMode ? "Search commands" : "Search models"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query invalidates wherever the cursor was.
              setCursor(0);
            }}
          />
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
            {rowCount}
          </span>
        </div>

        {!commandMode && (
          <div className="dial-scroll-none flex items-center gap-0.5 overflow-x-auto border-b border-line px-3 pb-2.5">
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
                className={`relative h-7 shrink-0 rounded-full px-2.5 text-[12px] font-medium capitalize transition-colors duration-150 ${
                  scope === item ? "text-foreground" : "text-muted hover:text-secondary"
                }`}
              >
                {scope === item && (
                  <motion.span
                    layoutId="palette-scope"
                    className="absolute inset-0 rounded-full bg-hover-2 shadow-hairline"
                    transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                  />
                )}
                <span className="relative">{item}</span>
              </button>
            ))}
          </div>
        )}

        <div
          ref={listRef}
          className={`dial-scroll max-h-[56vh] overflow-y-auto p-1.5 ${commandMode ? "border-t border-line" : ""}`}
        >
          <GlideMenu
            mode="active"
            activeKey={rowCount > 0 ? `${commandMode ? "c" : "m"}-${cursor}-${term}-${scope}` : null}
            highlightClassName="inset-x-0 rounded-control bg-hover-2"
          >
            {commandMode
              ? visibleCommands.map((c, idx) => (
                  <button
                    key={c.id}
                    data-idx={idx}
                    data-glide-row
                    data-glide-active={idx === cursor}
                    onMouseMove={() => idx !== cursor && setCursor(idx)}
                    onClick={() => runCommand(c)}
                    className="relative z-10 flex h-10 w-full items-center justify-between gap-4 rounded-control px-3 text-left"
                  >
                    <span className="truncate text-[13.5px] text-foreground">
                      {c.label}
                    </span>
                    {c.hint && (
                      <span className="shrink-0 font-mono text-[11px] text-muted">
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
                      data-glide-row
                      data-glide-active={idx === cursor}
                      onMouseMove={() => idx !== cursor && setCursor(idx)}
                      onClick={() => chooseModel(m.id)}
                      className="relative z-10 flex w-full items-start justify-between gap-4 overflow-hidden rounded-control px-3 py-2.5 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium text-foreground">
                            {m.name}
                          </span>
                          {m.id === current && (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-foreground px-1.5 py-px text-[10.5px] font-medium text-background">
                              <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="m3.5 8.5 3 3 6-6.5" />
                              </svg>
                              current
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted">
                          {m.id}
                        </span>
                        <span className="mt-1.5 flex">
                          <Chips m={m} />
                        </span>
                      </span>

                      <span className="shrink-0 pt-0.5 text-right font-mono text-[11.5px] leading-relaxed tabular-nums text-muted">
                        <span className="block text-secondary">
                          {formatPricePerMillion(m.promptPrice)}
                          {" / "}
                          {formatPricePerMillion(m.completionPrice)}
                        </span>
                        {m.contextLength && (
                          <span className="block">
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
          </GlideMenu>

          {!commandMode && models.length === 0 && (
            <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
              <span className="text-[13.5px] font-medium text-foreground">
                Catalog unavailable
              </span>
              <span className="text-[12.5px] text-muted">
                OpenRouter&apos;s model list could not be reached — try again in a moment.
              </span>
            </div>
          )}
          {rowCount === 0 && (commandMode || models.length > 0) && (
            <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
              <span className="text-[13.5px] font-medium text-foreground">No results</span>
              <span className="text-[12.5px] text-muted">
                Nothing matches “{term}”.
              </span>
            </div>
          )}
          {!commandMode && filteredModels.length > MAX_ROWS && (
            <p className="py-2 text-center text-[12px] text-muted">
              {filteredModels.length - MAX_ROWS} more — keep typing
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-line bg-hover px-4 py-2 text-[11.5px] text-muted">
          <span className="flex items-center gap-1">
            <span className="dial-kbd">↑</span>
            <span className="dial-kbd">↓</span>
            move
          </span>
          <span className="flex items-center gap-1">
            <span className="dial-kbd">⏎</span>
            {commandMode ? "run" : "select"}
          </span>
          <span className="flex items-center gap-1">
            <span className="dial-kbd">&gt;</span>
            commands
          </span>
          <span className="ml-auto flex items-center gap-1">
            <span className="dial-kbd">esc</span>
            close
          </span>
        </div>
      </div>
    </div>
  );
}

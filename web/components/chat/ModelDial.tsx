"use client";

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import EffortSlider, { EFFORT_DESCRIPTION, EFFORT_LABEL } from "./EffortSlider";
import GlideMenu from "@/components/ui/GlideMenu";
import { nextRecents } from "@/components/tuner/Palette";
import {
  capabilitiesFor,
  effortOptions,
  modelDisplayName as displayName,
  modelFor,
} from "@/lib/capabilities";
import type { ChatSettings, OpenRouterModel } from "@/lib/types";

/**
 * When someone has few recents, the quick list is topped up from these:
 * OpenRouter's floating `~…-latest` aliases, which always point at that
 * family's newest model and so never go stale. Any the catalog stops
 * offering simply drop out.
 */
const LATEST = [
  "~anthropic/claude-sonnet-latest",
  "~openai/gpt-sol-latest",
  "~google/gemini-pro-latest",
  "~deepseek/deepseek-pro-latest",
  "~x-ai/grok-latest",
];
const QUICK_ROWS = 5;
/** A row's height (`h-9`), for paging the list a screenful at a time. */
const ROW_PX = 36;

/** The current model, then recents, then the latest aliases — five at most. */
function quickModels(
  current: string,
  recents: readonly string[],
  models: OpenRouterModel[],
): string[] {
  const out: string[] = [];
  for (const id of [current, ...recents, ...LATEST]) {
    if (out.length >= QUICK_ROWS) break;
    if (out.includes(id)) continue;
    if (id !== current && !modelFor(id, models)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The whole catalog, searched the way the palette searches it — every word
 * must appear in the id or the name — with names that start with the query
 * first, since that is usually the one being typed.
 */
function searchModels(
  query: string,
  models: OpenRouterModel[],
  names: ReadonlyMap<string, string>,
): string[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const head = tokens.join(" ");
  const matched = models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  const leading = (m: OpenRouterModel) =>
    (names.get(m.id) ?? m.id).toLowerCase().startsWith(head) ? 0 : 1;
  return matched
    .map((m, i) => ({ m, i }))
    .sort((a, b) => leading(a.m) - leading(b.m) || a.i - b.i)
    .map(({ m }) => m.id);
}

/** "google" from "google/gemini-2.5-flash", "anthropic" from "~anthropic/…". */
function providerOf(id: string): string {
  return id.split("/")[0].replace(/^~/, "");
}

/** The rest of the catalog, under the short list: by provider, then by name. */
function restOfCatalog(
  shown: readonly string[],
  models: OpenRouterModel[],
  names: ReadonlyMap<string, string>,
): string[] {
  const skip = new Set(shown);
  return models
    .filter((m) => !skip.has(m.id))
    .map((m) => ({ id: m.id, provider: providerOf(m.id), name: names.get(m.id) ?? m.id }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
    .map(({ id }) => id);
}

/**
 * One model in the list. Memoized: the whole catalog can be on the list, and
 * the cursor moving under the pointer should repaint two rows, not 470.
 */
const ModelRow = memo(function ModelRow({
  id,
  index,
  name,
  provider,
  current,
  active,
  onHover,
  onPick,
}: {
  id: string;
  index: number;
  name: string;
  /** Shown where the list is no longer the person's own short list. */
  provider: string | null;
  current: boolean;
  active: boolean;
  onHover: (index: number) => void;
  onPick: (id: string) => void;
}) {
  return (
    <button
      id={`dial-model-${index}`}
      type="button"
      role="option"
      aria-selected={current}
      tabIndex={-1}
      data-row={index}
      data-glide-row
      data-glide-active={active}
      onMouseMove={() => onHover(index)}
      onClick={() => onPick(id)}
      title={id}
      className="relative z-10 flex h-9 w-full items-center gap-2 px-2.5 text-left outline-none"
    >
      <span
        className={`min-w-0 flex-1 truncate text-[13.5px] ${
          current ? "font-medium text-foreground" : "text-secondary"
        }`}
      >
        {name}
      </span>
      {current ? (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-foreground" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m3.5 8.5 3 3 6-6.5" />
        </svg>
      ) : (
        provider && (
          <span className="shrink-0 font-mono text-[10.5px] text-muted">{provider}</span>
        )
      )}
    </button>
  );
});

const Sparkle = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
    <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" />
  </svg>
);

/**
 * The model and how hard it thinks, as one small dial beside send.
 *
 * Closed it is a squircle reading "Claude Sonnet 4.6 Medium": the model, and
 * the effort in the muted ink when thinking is on. Open, it is a panel with
 * two views that trade places sideways. Reasoning comes first, because it is
 * what changes between turns: the model's name heads it and leads on to the
 * models, and under it the effort slider. A model without a reasoning mode
 * (or the image tool) opens straight onto the models.
 *
 * The models view is a search, not a menu. Its field has the focus, so
 * typing filters the whole catalog in place — the list eases to the new
 * height as it narrows — and with nothing typed it opens on the short list
 * (current, recents, the newest of the big families) with the rest of the
 * catalog below it, by provider. Either way the list scrolls through all of
 * it, its edges fading where there is more. Arrow keys move through the
 * results, Page Up/Down a screenful, and Enter takes one, so a model change
 * never leaves the keyboard. The palette is the extended view, for comparing
 * prices, context and capabilities: the expand button beside the field opens
 * it, as does ⌘K from inside the dial — both carrying what was typed, so the
 * search goes on where it was.
 *
 * Height is measured and written to the panel, so changes ease rather than
 * snap (see `.dial-model-panel`).
 */
export default function ModelDial({
  settings,
  models,
  recentModels,
  imageMode,
  onSettingsChange,
  onRecent,
  onOpenCatalog,
}: {
  settings: ChatSettings;
  models: OpenRouterModel[];
  /** Newest first, from the account's settings blob. */
  recentModels: readonly string[];
  imageMode: boolean;
  onSettingsChange: (patch: Partial<ChatSettings>) => void;
  onRecent: (next: string[]) => void;
  /** Open the full palette, searching for `query`. */
  onOpenCatalog: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"tune" | "models">("tune");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const caps = capabilitiesFor(settings.model, models);
  const efforts = effortOptions(caps);
  const canTune = !imageMode && caps.reasoning && efforts.length > 0;
  const shown = canTune ? view : "models";
  const name = displayName(settings.model, models);
  const thinking = canTune && settings.reasoning !== "off";

  const listing = open && shown === "models";
  const searching = query.trim().length > 0;
  const names = useMemo(
    () => new Map(models.map((m) => [m.id, displayName(m.id, models)])),
    [models],
  );
  const matches = useMemo(
    () => (listing && searching ? searchModels(query, models, names) : []),
    [listing, searching, query, models, names],
  );
  const quick = useMemo(
    () => quickModels(settings.model, recentModels, models),
    [settings.model, recentModels, models],
  );
  const rest = useMemo(
    () => (listing && !searching ? restOfCatalog(quick, models, names) : []),
    [listing, searching, quick, models, names],
  );
  const rows = useMemo(
    () => (searching ? matches : [...quick, ...rest]),
    [searching, matches, quick, rest],
  );
  // Clamped on read: a narrowing result must not leave the cursor past the end.
  const cursor = Math.min(active, Math.max(rows.length - 1, 0));

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const go = (next: "tune" | "models") => {
    setDirection(next === "models" ? "forward" : "back");
    setView(next);
  };

  const choose = (id: string) => {
    if (id !== settings.model) onSettingsChange({ model: id });
    onRecent(nextRecents(recentModels, id));
    close(true);
  };

  // Stable for the memoized rows, always calling the latest `choose`.
  const chooseRef = useRef(choose);
  useLayoutEffect(() => {
    chooseRef.current = choose;
  });
  const pick = useCallback((id: string) => chooseRef.current(id), []);
  const hover = useCallback((index: number) => setActive(index), []);

  // The keyboard's row is scrolled to here, not in an effect on the cursor:
  // a row the pointer moves onto at the faded edge must not scroll the list
  // out from under it.
  const moveTo = (index: number) => {
    setActive(index);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  // Fade an edge only where there is more to scroll to (`.dial-scroll-edges`).
  const edges = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.toggleAttribute("data-above", list.scrollTop > 1);
    list.toggleAttribute(
      "data-below",
      list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    );
  }, []);

  const openCatalog = () => {
    close();
    onOpenCatalog(query.trim());
  };

  const search = (next: string) => {
    setQuery(next);
    setActive(0);
    // A new result starts at its top.
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  // Outside presses close it.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Land where the keyboard is useful: the slider, or the search field.
  useEffect(() => {
    if (!open) return;
    const target =
      shown === "tune"
        ? ref.current?.querySelector<HTMLElement>("[role=slider]")
        : searchRef.current;
    target?.focus({ preventScroll: true });
  }, [open, shown]);

  useLayoutEffect(() => {
    if (listing) edges();
  }, [listing, rows, edges]);

  // The panel's height follows its content, eased (see `.dial-model-panel`).
  // Each view is its own element, so the observer moves with it; only the
  // first placement after opening goes in without the ease.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const inner = innerRef.current;
    if (!open || !panel || !inner) return;
    const fit = () => {
      panel.style.height = `${inner.offsetHeight}px`;
    };
    if (!panel.style.height) {
      panel.style.transition = "none";
      fit();
      void panel.offsetHeight;
      panel.style.transition = "";
    } else {
      fit();
    }
    const observer = new ResizeObserver(fit);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [open, shown]);

  return (
    // Not positioned itself: the panel anchors to the composer's right-hand
    // group, so its edge lines up with send's and a phone keeps a margin.
    <div
      ref={ref}
      className="min-w-0"
      onKeyDown={(e) => {
        if (!open) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
          // The extended view, carrying the search — not the shell's toggle.
          e.preventDefault();
          e.stopPropagation();
          openCatalog();
          return;
        }
        if (e.key === "Escape") {
          // Escape is also "stop generating" further up; this one is ours.
          e.preventDefault();
          e.stopPropagation();
          if (shown === "models" && query) search("");
          else close(true);
          return;
        }
        if (
          shown === "tune" &&
          e.key === "Enter" &&
          (e.target as HTMLElement).getAttribute("role") === "slider"
        ) {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${name}${thinking ? `, reasoning ${EFFORT_LABEL[settings.reasoning].toLowerCase()}` : ""}`}
        title="Model and reasoning"
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setView("tune");
          setDirection("forward");
          search("");
          setOpen(true);
        }}
        className={`dial-squircle flex h-8 min-w-0 max-w-[min(16rem,48vw)] items-center gap-1.5 pl-2.5 pr-2 text-[12.5px] font-medium transition-[background-color,color,transform] duration-150 [--sq:10px] active:scale-[0.97] ${
          open ? "bg-hover-2 text-foreground" : "text-secondary hover:bg-hover-2 hover:text-foreground"
        }`}
      >
        <span className="truncate">{name}</span>
        {thinking && (
          <span className="shrink-0 font-normal text-muted">
            {EFFORT_LABEL[settings.reasoning]}
          </span>
        )}
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m3.25 7.25 2.75-2.5 2.75 2.5" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={shown === "tune" ? "Reasoning" : "Model"}
          className="dial-squircle absolute bottom-full right-0 z-50 mb-2 w-[min(320px,calc(100vw-40px))] origin-bottom-right bg-panel shadow-overlay [--sq:14px]"
          style={{ animation: "dial-pop-in 170ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          <div ref={panelRef} className="dial-model-panel">
            <div
              ref={innerRef}
              key={shown}
              className="p-1.5"
              style={{
                animation: `${direction === "forward" ? "dial-view-forward" : "dial-view-back"} 200ms cubic-bezier(0.23,1,0.32,1) both`,
              }}
            >
              {shown === "tune" ? (
                <>
                  <button
                    type="button"
                    onClick={() => go("models")}
                    title="Choose a model"
                    className="dial-squircle group flex h-10 w-full items-center gap-2 px-2.5 text-left transition-colors duration-150 [--sq:9px] hover:bg-hover"
                  >
                    <Sparkle className="h-3.5 w-3.5 shrink-0 text-muted" />
                    <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">
                      {name}
                    </span>
                    <span
                      key={settings.reasoning}
                      className="shrink-0 text-[13.5px] text-muted"
                      style={{ animation: "dial-fade-in 180ms ease-out both" }}
                    >
                      {EFFORT_LABEL[settings.reasoning]}
                    </span>
                    <svg viewBox="0 0 12 12" className="ml-auto h-3 w-3 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m4.5 2.75 3.25 3.25-3.25 3.25" />
                    </svg>
                  </button>
                  <div className="px-1.5 pb-1.5 pt-1.5">
                    <EffortSlider
                      value={settings.reasoning}
                      options={efforts}
                      onChange={(reasoning) => onSettingsChange({ reasoning })}
                    />
                    <div className="mt-2.5 flex items-baseline justify-between gap-3 px-0.5">
                      <p
                        key={settings.reasoning}
                        className="text-[12px] leading-relaxed text-muted"
                        style={{ animation: "dial-fade-in 200ms ease-out both" }}
                      >
                        {EFFORT_DESCRIPTION[settings.reasoning]}
                      </p>
                      {caps.defaultEffort && caps.defaultEffort !== "off" && (
                        <span className="shrink-0 font-mono text-[10.5px] text-muted">
                          default {EFFORT_LABEL[caps.defaultEffort].toLowerCase()}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1 pb-1">
                    {canTune && (
                      <button
                        type="button"
                        onClick={() => go("tune")}
                        aria-label="Back to reasoning"
                        title="Back to reasoning"
                        className="dial-squircle flex size-8 shrink-0 items-center justify-center text-muted transition-colors duration-150 [--sq:9px] hover:bg-hover hover:text-foreground"
                      >
                        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M7.5 2.75 4.25 6l3.25 3.25" />
                        </svg>
                      </button>
                    )}
                    <label className="dial-squircle flex h-8 min-w-0 flex-1 cursor-text items-center gap-2 bg-field px-2.5 text-muted shadow-field [--sq:9px]">
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                        <circle cx="7" cy="7" r="4.25" />
                        <path d="m10.25 10.25 3.25 3.25" />
                      </svg>
                      <input
                        ref={searchRef}
                        value={query}
                        onChange={(e) => search(e.target.value)}
                        onKeyDown={(e) => {
                          const step =
                            e.key === "ArrowDown" || e.key === "ArrowUp"
                              ? 1
                              : e.key === "PageDown" || e.key === "PageUp"
                                ? Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / ROW_PX) - 1)
                                : 0;
                          if (step > 0 && rows.length > 0) {
                            e.preventDefault();
                            moveTo(
                              e.key === "ArrowDown" || e.key === "PageDown"
                                ? Math.min(rows.length - 1, cursor + step)
                                : Math.max(0, cursor - step),
                            );
                          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            const id = rows[cursor];
                            if (id) choose(id);
                          }
                        }}
                        placeholder={`Search ${models.length > 0 ? `${models.length} ` : ""}models`}
                        aria-label="Search models"
                        aria-controls="dial-model-list"
                        aria-activedescendant={rows[cursor] ? `dial-model-${cursor}` : undefined}
                        spellCheck={false}
                        autoComplete="off"
                        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                      />
                      {query && (
                        <button
                          type="button"
                          onClick={() => {
                            search("");
                            searchRef.current?.focus();
                          }}
                          aria-label="Clear search"
                          className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted transition-colors hover:text-foreground"
                        >
                          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                            <path d="m4 4 8 8M12 4l-8 8" />
                          </svg>
                        </button>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={openCatalog}
                      aria-label="Open the full model catalog"
                      title={query ? `All results for “${query.trim()}” (⌘K)` : "All models, with prices and capabilities (⌘K)"}
                      className="dial-squircle group/expand flex size-8 shrink-0 items-center justify-center text-muted transition-[background-color,color] duration-150 [--sq:9px] hover:bg-hover hover:text-foreground"
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 transition-transform duration-200 ease-out-strong group-hover/expand:scale-110" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M9.75 2.75h3.5v3.5M13.25 2.75 9.5 6.5M6.25 13.25h-3.5v-3.5M2.75 13.25 6.5 9.5" />
                      </svg>
                    </button>
                  </div>

                  <div
                    ref={listRef}
                    id="dial-model-list"
                    role="listbox"
                    aria-label="Models"
                    onScroll={edges}
                    className="dial-scroll-none dial-scroll-edges max-h-[min(272px,42vh)] scroll-py-5 overflow-y-auto overscroll-contain"
                  >
                    <GlideMenu
                      mode="active"
                      activeKey={rows.length > 0 ? `${cursor}-${query}` : null}
                      highlightClassName="dial-squircle inset-x-0 bg-hover [--sq:9px]"
                    >
                      {rows.map((id, i) => (
                        <Fragment key={id}>
                          {!searching && i === quick.length && (
                            <div
                              role="presentation"
                              className="flex items-baseline justify-between px-2.5 pb-1.5 pt-3 text-[11.5px] text-muted"
                            >
                              <span>All models</span>
                              <span className="font-mono text-[10.5px] tabular-nums">
                                {rest.length}
                              </span>
                            </div>
                          )}
                          <ModelRow
                            id={id}
                            index={i}
                            name={names.get(id) ?? displayName(id, models)}
                            provider={searching || i >= quick.length ? providerOf(id) : null}
                            current={id === settings.model}
                            active={i === cursor}
                            onHover={hover}
                            onPick={pick}
                          />
                        </Fragment>
                      ))}
                    </GlideMenu>

                    {searching && rows.length === 0 && (
                      <p className="px-2.5 py-3 text-[12.5px] text-muted">
                        Nothing matches “{query.trim()}”.
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

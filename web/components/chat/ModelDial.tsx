"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * models, and under it the effort slider. Models is deliberately short —
 * the current one, recents, and the newest of the big families — because
 * the whole catalog is one keystroke away: typing anything there carries
 * what was typed into the palette, already searching, and its search field
 * says so. A model without a reasoning mode (or the image tool) opens
 * straight onto the models.
 *
 * Height is measured and written to the panel, so changing views eases
 * rather than snaps (see `.dial-model-panel`).
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
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const caps = capabilitiesFor(settings.model, models);
  const efforts = effortOptions(caps);
  const canTune = !imageMode && caps.reasoning && efforts.length > 0;
  const shown = canTune ? view : "models";
  const name = displayName(settings.model, models);
  const thinking = canTune && settings.reasoning !== "off";
  const quick = quickModels(settings.model, recentModels, models);

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

  const openCatalog = (query: string) => {
    close();
    onOpenCatalog(query);
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

  // Land where the keyboard is useful: the slider, or the current model.
  useEffect(() => {
    if (!open) return;
    const target =
      shown === "tune"
        ? ref.current?.querySelector<HTMLElement>("[role=slider]")
        : ref.current?.querySelector<HTMLElement>("[data-quick-row][aria-checked=true]");
    target?.focus({ preventScroll: true });
  }, [open, shown]);

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
        if (e.key === "Escape") {
          // Escape is also "stop generating" further up; this one is ours.
          e.preventDefault();
          e.stopPropagation();
          close(true);
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
          return;
        }
        if (shown !== "models") return;
        const inField = (e.target as HTMLElement).tagName === "INPUT";
        if (!inField && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
          // Typing in the short list means looking for something not in it.
          e.preventDefault();
          openCatalog(e.key);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [
            ...(ref.current?.querySelectorAll<HTMLElement>("[data-quick-row], [data-quick-search]") ?? []),
          ];
          const at = rows.indexOf(document.activeElement as HTMLElement);
          const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
          rows[next]?.focus();
        } else if (e.key === "ArrowLeft" && canTune && !inField) {
          e.preventDefault();
          go("tune");
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
          className="dial-squircle absolute bottom-full right-0 z-50 mb-2 w-[min(304px,calc(100vw-40px))] origin-bottom-right bg-panel shadow-overlay [--sq:14px]"
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
                  <div className="flex h-8 items-center gap-0.5 px-1">
                    {canTune && (
                      <button
                        type="button"
                        onClick={() => go("tune")}
                        aria-label="Back to reasoning"
                        className="dial-squircle flex size-7 items-center justify-center text-muted transition-colors duration-150 [--sq:8px] hover:bg-hover hover:text-foreground"
                      >
                        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M7.5 2.75 4.25 6l3.25 3.25" />
                        </svg>
                      </button>
                    )}
                    <span className="px-1.5 text-[12px] font-medium text-muted">Model</span>
                  </div>

                  <GlideMenu highlightClassName="dial-squircle inset-x-0 bg-hover [--sq:9px]">
                    <div role="radiogroup" aria-label="Model">
                      {quick.map((id) => {
                        const current = id === settings.model;
                        return (
                          <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={current}
                            data-glide-row
                            data-quick-row
                            onClick={() => choose(id)}
                            title={id}
                            className="relative z-10 flex h-9 w-full items-center gap-2 px-2.5 text-left outline-none"
                          >
                            <span
                              className={`min-w-0 flex-1 truncate text-[13.5px] ${
                                current ? "font-medium text-foreground" : "text-secondary"
                              }`}
                            >
                              {displayName(id, models)}
                            </span>
                            {current && (
                              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-foreground" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="m3.5 8.5 3 3 6-6.5" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </GlideMenu>

                  <label className="dial-squircle mt-1.5 flex h-9 cursor-text items-center gap-2 bg-field px-2.5 text-muted shadow-field [--sq:9px]">
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                      <circle cx="7" cy="7" r="4.25" />
                      <path d="m10.25 10.25 3.25 3.25" />
                    </svg>
                    <input
                      data-quick-search
                      value=""
                      onChange={(e) => {
                        if (e.target.value) openCatalog(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          openCatalog("");
                        }
                      }}
                      placeholder={`All ${models.length > 0 ? `${models.length} ` : ""}models…`}
                      aria-label="Search all models"
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                    />
                    <button
                      type="button"
                      onClick={() => openCatalog("")}
                      title="Open the full model list"
                      className="dial-kbd hidden shrink-0 transition-colors hover:text-foreground sm:inline-flex"
                    >
                      ⌘K
                    </button>
                  </label>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

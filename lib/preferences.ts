"use client";

import {
  DEFAULT_SETTINGS,
  MODEL_ID_PATTERN,
  REASONING_EFFORTS,
  type ChatSettings,
  type ReasoningEffort,
} from "./types";

/**
 * Preferences that outlive a single conversation.
 *
 * Two distinct things live here:
 *
 *  - **Session defaults** — the model, reasoning effort and search toggle a
 *    new chat starts with. Previously only the model carried over, so every
 *    new thread silently reset reasoning to `off`; if you work with thinking
 *    on, having to re-arm it each time is the wrong default.
 *  - **Rail geometry** — the sidebar's width and collapsed state, applied as
 *    a CSS custom property before paint (see the boot script in layout.tsx)
 *    so a restored width never flashes.
 */

const DEFAULTS_KEY = "dial:defaults";
export const RAIL_KEY = "dial:rail";

export const RAIL_MIN = 180;
export const RAIL_MAX = 460;
export const RAIL_DEFAULT = 272;

/* ------------------------------ session ------------------------------- */

export type SessionDefaults = Pick<
  ChatSettings,
  "model" | "reasoning" | "search"
>;

function isEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && REASONING_EFFORTS.includes(v as ReasoningEffort);
}

export function readDefaults(): SessionDefaults {
  const fallback: SessionDefaults = {
    model: DEFAULT_SETTINGS.model,
    reasoning: DEFAULT_SETTINGS.reasoning,
    search: DEFAULT_SETTINGS.search,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<SessionDefaults>;
    return {
      // Older builds persisted display names as if they were API ids. That
      // eventually reached OpenRouter as e.g. "Claude Sonnet" and produced
      // the opaque `expected provider/model-slug` error. Only restore ids the
      // wire format can actually accept.
      model:
        typeof p.model === "string" && MODEL_ID_PATTERN.test(p.model)
          ? p.model
          : fallback.model,
      reasoning: isEffort(p.reasoning) ? p.reasoning : fallback.reasoning,
      search: typeof p.search === "boolean" ? p.search : fallback.search,
    };
  } catch {
    return fallback;
  }
}

/** Remember the knobs a new chat should inherit. */
export function writeDefaults(s: ChatSettings) {
  try {
    localStorage.setItem(
      DEFAULTS_KEY,
      JSON.stringify({
        model: s.model,
        reasoning: s.reasoning,
        search: s.search,
      } satisfies SessionDefaults),
    );
  } catch {
    // Storage disabled — defaults just won't survive a reload.
  }
}

/** A fresh conversation's settings: session knobs, no inherited prompt. */
export function newConversationSettings(): ChatSettings {
  return { ...DEFAULT_SETTINGS, ...readDefaults(), system: "" };
}

/* -------------------------------- rail -------------------------------- */

export type RailState = { width: number; collapsed: boolean };

export function clampRail(w: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)));
}

export function readRail(): RailState {
  const fallback: RailState = { width: RAIL_DEFAULT, collapsed: false };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<RailState>;
    return {
      width: typeof p.width === "number" ? clampRail(p.width) : fallback.width,
      collapsed: p.collapsed === true,
    };
  } catch {
    return fallback;
  }
}

export function writeRail(state: RailState) {
  try {
    localStorage.setItem(RAIL_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled — geometry resets next load.
  }
}

/** Push geometry onto the document so CSS picks it up without a re-render. */
export function applyRail(state: RailState) {
  const root = document.documentElement;
  root.style.setProperty("--dial-rail-w", `${clampRail(state.width)}px`);
  root.classList.toggle("dial-rail-collapsed", state.collapsed);
}

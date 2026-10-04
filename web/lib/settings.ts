"use client";

import { sealRecord, openRecord } from "./crypto";
import {
  DEFAULT_SETTINGS as DEFAULT_CHAT_SETTINGS,
  MODEL_ID_PATTERN,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./types";

/**
 * Account settings — the things that should follow a person to any device
 * they sign in from.
 *
 * This is deliberately one blob rather than a column per preference. The
 * server treats it as opaque, so adding a setting is a client-only change
 * and never a migration; and for accounts with a vault key the whole thing
 * is ciphertext, which a column layout could not be.
 *
 * The OpenRouter key lives here, and that is the reason the blob is never
 * stored in the clear. It is a billable credential: a database dump that
 * yielded one would be someone else's bill.
 */

export const THEMES = ["system", "light", "dark"] as const;
export const FONTS = ["geist", "system", "serif"] as const;
export const TEXT_SIZES = ["small", "medium", "large"] as const;
export const WIDTHS = ["narrow", "medium", "wide"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;

/** Instructions ride along with every request; keep them a paragraph or ten. */
export const INSTRUCTIONS_MAX = 8000;

export type Theme = (typeof THEMES)[number];
export type Font = (typeof FONTS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type Width = (typeof WIDTHS)[number];
export type Density = (typeof DENSITIES)[number];

/**
 * The part of the settings that has to be readable before first paint.
 *
 * It is split out because it is the only part with a device-local mirror. A
 * theme cannot wait for a network round trip and a decryption without the
 * page visibly flashing the wrong one, and the cloud copy is sealed — it is
 * not readable at all until after sign-in. Nothing in here identifies anyone
 * or costs anything if read: five enums and a sidebar width.
 */
export type Appearance = {
  theme: Theme;
  font: Font;
  textSize: TextSize;
  width: Width;
  density: Density;
  /** Rail geometry, in pixels. Clamped to the drag handle's own bounds. */
  railWidth: number;
  railCollapsed: boolean;
};

export type UserSettings = Appearance & {
  /**
   * Keep the non-extractable vault key in this browser between visits.
   * False is the high-privacy mode: the key stays in memory for this tab only
   * and the password is required again after a reload.
   */
  rememberDeviceKey: boolean;
  /** The user's own OpenRouter key. Null when they have not connected one. */
  openrouterKey: string | null;
  /**
   * Standing guidance sent as the system prompt in every conversation. It
   * replaced the per-conversation prompt: one set of instructions that
   * follows the person is what people actually reach for, and a prompt
   * hidden behind a composer button was easy to forget was set.
   */
  instructions: string;
  /** What a new chat inherits — the knobs last used, not hard defaults. */
  defaults: {
    model: string;
    reasoning: ReasoningEffort;
  };
  /** Most-recently-picked models, newest first, for the palette. */
  recentModels: string[];
  /** The thread that was open last, so a new device lands where you left. */
  activeThread: string | null;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  font: "geist",
  textSize: "medium",
  width: "medium",
  density: "comfortable",
  railWidth: 272,
  railCollapsed: false,
};

export const DEFAULT_SETTINGS: UserSettings = {
  ...DEFAULT_APPEARANCE,
  rememberDeviceKey: true,
  openrouterKey: null,
  instructions: "",
  defaults: {
    model: DEFAULT_CHAT_SETTINGS.model,
    reasoning: DEFAULT_CHAT_SETTINGS.reasoning,
  },
  recentModels: [],
  activeThread: null,
};

/** The rail's own bounds, shared with the drag handle. */
export const RAIL_MIN = 180;
export const RAIL_MAX = 460;

/** Narrow an untrusted blob to the current shape, field by field. */
function coerce<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampRail(value: unknown): number {
  const width = Number(value);
  if (!Number.isFinite(width)) return DEFAULT_APPEARANCE.railWidth;
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(width)));
}

export function normalizeAppearance(raw: unknown): Appearance {
  const input = (raw ?? {}) as Partial<Appearance>;
  return {
    theme: coerce(input.theme, THEMES, DEFAULT_APPEARANCE.theme),
    font: coerce(input.font, FONTS, DEFAULT_APPEARANCE.font),
    textSize: coerce(input.textSize, TEXT_SIZES, DEFAULT_APPEARANCE.textSize),
    width: coerce(input.width, WIDTHS, DEFAULT_APPEARANCE.width),
    density: coerce(input.density, DENSITIES, DEFAULT_APPEARANCE.density),
    railWidth: clampRail(input.railWidth),
    railCollapsed: input.railCollapsed === true,
  };
}

export function normalizeSettings(raw: unknown): UserSettings {
  const input = (raw ?? {}) as Partial<UserSettings>;
  const defaults = (input.defaults ?? {}) as Partial<UserSettings["defaults"]>;
  return {
    ...normalizeAppearance(input),
    rememberDeviceKey: input.rememberDeviceKey !== false,
    openrouterKey:
      typeof input.openrouterKey === "string" && input.openrouterKey
        ? input.openrouterKey
        : null,
    instructions:
      typeof input.instructions === "string"
        ? input.instructions.slice(0, INSTRUCTIONS_MAX)
        : "",
    defaults: {
      model:
        typeof defaults.model === "string" && MODEL_ID_PATTERN.test(defaults.model)
          ? defaults.model
          : DEFAULT_SETTINGS.defaults.model,
      reasoning: coerce(
        defaults.reasoning,
        REASONING_EFFORTS,
        DEFAULT_SETTINGS.defaults.reasoning,
      ),
    },
    recentModels: Array.isArray(input.recentModels)
      ? input.recentModels
          .filter(
            (id): id is string =>
              typeof id === "string" && MODEL_ID_PATTERN.test(id),
          )
          .slice(0, 6)
      : [],
    activeThread:
      typeof input.activeThread === "string" && input.activeThread
        ? input.activeThread
        : null,
  };
}

/* ------------------------------ appearance ----------------------------- */

/**
 * Appearance is applied as CSS custom properties on the root element, the
 * same way rail geometry already is. Nothing about it lives in React state:
 * a theme change should not re-render the transcript, and a stored value
 * must be readable before first paint without a hydration mismatch.
 */

const FONT_STACKS: Record<Font, string> = {
  // The loaded webfont, with the platform stack behind it.
  geist: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  // No download at all — whatever the OS already considers correct.
  system:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
};

const TEXT_SCALE: Record<TextSize, string> = {
  small: "0.9375",
  medium: "1",
  large: "1.0937",
};

const COLUMN_WIDTH: Record<Width, string> = {
  narrow: "640px",
  medium: "760px",
  wide: "920px",
};

const ROW_GAP: Record<Density, string> = {
  comfortable: "2.25rem",
  compact: "1.5rem",
};

export function applyAppearance(settings: Appearance): void {
  const root = document.documentElement;
  root.style.setProperty("--dial-font", FONT_STACKS[settings.font]);
  root.style.setProperty("--dial-text-scale", TEXT_SCALE[settings.textSize]);
  root.style.setProperty("--dial-column", COLUMN_WIDTH[settings.width]);
  root.style.setProperty("--dial-row-gap", ROW_GAP[settings.density]);
  // Rail geometry travels with the account now, but it is still written as a
  // custom property rather than React state: width in state would re-render
  // the whole list on every pointer move during a drag.
  root.style.setProperty("--dial-rail-w", `${settings.railWidth}px`);
  root.classList.toggle("dial-rail-collapsed", settings.railCollapsed);
  applyTheme(settings.theme);
}

/**
 * `system` is not a third palette — it is the absence of a choice, so the
 * class is removed and the media query decides. Storing "dark" when someone
 * meant "follow my OS" is a small lie the UI would then have to maintain.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  root.dataset.themeChoice = theme;
}

/* -------------------------------- storage ------------------------------ */

/**
 * The one key this app keeps in `localStorage`.
 *
 * Everything else that used to live there — the OpenRouter key, the sync
 * cursor, the open thread, the session defaults, the recent models, the rail
 * geometry, the model catalog — is either in the sealed cloud blob or gone.
 * `dial:credential` and the old `dial:settings` both held the user's
 * OpenRouter key in the clear on disk, which is the single worst thing that
 * was in there and the reason this cleanup was worth doing.
 *
 * What remains is appearance plus one non-sensitive device-security choice.
 * Appearance is needed because the pre-paint script in `app/layout.tsx` runs
 * before any network request and before the vault key exists; without a local
 * hint every load paints the default theme and then snaps to the real one.
 * `rememberDeviceKey` is mirrored so the locked screen can accurately explain
 * whether this browser is meant to retain its non-extractable key before the
 * sealed cloud settings can be opened.
 *
 * `PURGED` are the keys previous builds wrote. They are removed on load
 * rather than left to rot, because two of them are credentials.
 */
const LOCAL_KEY = "dial:appearance";

const PURGED = [
  "dial:settings",
  "dial:credential",
  "dial:sync-cursor",
  "dial:active",
  "dial:defaults",
  "dial:rail",
  "dial:theme",
  "dial:recent-models",
  "dial:catalog",
];

export type LocalPreferences = Appearance & {
  rememberDeviceKey: boolean;
};

function normalizeLocal(raw: unknown): LocalPreferences {
  const input = (raw ?? {}) as Partial<LocalPreferences>;
  return {
    ...normalizeAppearance(input),
    rememberDeviceKey: input.rememberDeviceKey !== false,
  };
}

export function readLocal(): LocalPreferences {
  if (typeof window === "undefined") {
    return {
      ...DEFAULT_APPEARANCE,
      rememberDeviceKey: DEFAULT_SETTINGS.rememberDeviceKey,
    };
  }
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return normalizeLocal(raw ? JSON.parse(raw) : null);
  } catch {
    return {
      ...DEFAULT_APPEARANCE,
      rememberDeviceKey: DEFAULT_SETTINGS.rememberDeviceKey,
    };
  }
}

/** Mirror appearance and the device-key policy; no content or credential. */
export function writeLocal(
  settings: UserSettings | LocalPreferences,
): void {
  try {
    const local = normalizeLocal(settings);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
  } catch {
    // Storage disabled — both preferences live for this session only.
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Delete what earlier builds left behind. Idempotent, runs once per load. */
export function purgeLegacyLocal(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of PURGED) localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/* --------------------------------- cloud ------------------------------- */

/** Fixed id: settings are one record, so the AAD binding needs a constant. */
const SETTINGS_RECORD_ID = "settings";

export type RemoteState = {
  settings: UserSettings | null;
  encryption: "none" | "password" | "passphrase";
  rev: number;
};

/** A supplied key exists, but it cannot open this account's settings blob. */
export class SettingsDecryptError extends Error {
  constructor(readonly encryption: RemoteState["encryption"]) {
    super("this browser's saved key does not unlock this account");
    this.name = "SettingsDecryptError";
  }
}

/**
 * Read settings from the account.
 *
 * When the account is encrypted the blob is ciphertext and needs the vault
 * key; without it we return null rather than guessing, so the caller can
 * keep using the local mirror instead of overwriting it with nothing.
 */
/** What the account is using, for the readouts in settings. */
export type AccountUsage = {
  blobBytes: number;
  blobCount: number;
  blobQuota: number;
  /** Live conversations, and messages across all of them. */
  threads: number;
  messages: number;
};

/** Storage totals only. Cheap enough to call whenever settings is opened. */
export async function fetchUsage(): Promise<AccountUsage | null> {
  try {
    const response = await fetch("/v1/state", { credentials: "same-origin" });
    if (!response.ok) return null;
    const payload = (await response.json()) as { usage?: AccountUsage };
    return payload.usage ?? null;
  } catch {
    return null;
  }
}

export async function fetchRemote(kek: CryptoKey | null): Promise<RemoteState> {
  const response = await fetch("/v1/state", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`settings unavailable (${response.status})`);

  const payload = (await response.json()) as {
    settings: string | null;
    encryption: RemoteState["encryption"];
    rev: number;
  };

  if (!payload.settings) {
    return { settings: null, encryption: payload.encryption, rev: payload.rev };
  }

  if (payload.encryption === "none") {
    try {
      return {
        settings: normalizeSettings(JSON.parse(payload.settings)),
        encryption: payload.encryption,
        rev: payload.rev,
      };
    } catch {
      return { settings: null, encryption: payload.encryption, rev: payload.rev };
    }
  }

  if (!kek) {
    return { settings: null, encryption: payload.encryption, rev: payload.rev };
  }
  const opened = await openRecord<UserSettings>(
    kek,
    SETTINGS_RECORD_ID,
    payload.settings,
  );
  if (!opened) throw new SettingsDecryptError(payload.encryption);
  return {
    settings: normalizeSettings(opened),
    encryption: payload.encryption,
    rev: payload.rev,
  };
}

/** Raised instead of writing plaintext over an encrypted account. */
export class WouldDowngradeError extends Error {
  constructor() {
    super("refusing to write plaintext settings over an encrypted account");
    this.name = "WouldDowngradeError";
  }
}

/**
 * Write settings to the account.
 *
 * Passing a key both encrypts the blob and declares the account encrypted —
 * the two must move together, or the next read would try to parse ciphertext
 * as JSON.
 *
 * `accountEncrypted` is the server's own view, and it exists because
 * inferring "not encrypted" from "no key in hand" caused real data loss: a
 * device that had been signed out of its key still had a valid session, took
 * the no-key branch, and overwrote the account's ciphertext with plaintext
 * defaults. The account was then unopenable by the correct password, because
 * the blob it was asked to decrypt was no longer ciphertext.
 *
 * Absence of a key is not evidence that an account is unencrypted. This
 * function now refuses rather than guesses.
 */
export async function pushRemote(
  settings: UserSettings,
  kek: CryptoKey | null,
  accountEncrypted = false,
  {
    client = null,
    notify = false,
  }: {
    /** This device's live-socket id, so the notification skips it. */
    client?: string | null;
    /** A shared setting changed: tell the account's other devices. */
    notify?: boolean;
  } = {},
): Promise<void> {
  if (accountEncrypted && !kek) throw new WouldDowngradeError();

  const body = {
    ...(kek
      ? {
          settings: await sealRecord(kek, SETTINGS_RECORD_ID, settings),
          encryption: "password" as const,
        }
      : { settings: JSON.stringify(settings) }),
    ...(notify ? { notify: true, ...(client ? { client } : {}) } : {}),
  };

  const response = await fetch("/v1/state", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`could not save settings (${response.status})`);
}

"use client";

import { sealRecord, openRecord } from "./crypto";

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

export type Theme = (typeof THEMES)[number];
export type Font = (typeof FONTS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type Width = (typeof WIDTHS)[number];
export type Density = (typeof DENSITIES)[number];

export type UserSettings = {
  /** The user's own OpenRouter key. Null when they have not connected one. */
  openrouterKey: string | null;
  theme: Theme;
  font: Font;
  textSize: TextSize;
  width: Width;
  density: Density;
};

export const DEFAULT_SETTINGS: UserSettings = {
  openrouterKey: null,
  theme: "dark",
  font: "geist",
  textSize: "medium",
  width: "medium",
  density: "comfortable",
};

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

export function normalizeSettings(raw: unknown): UserSettings {
  const input = (raw ?? {}) as Partial<UserSettings>;
  return {
    openrouterKey:
      typeof input.openrouterKey === "string" && input.openrouterKey
        ? input.openrouterKey
        : null,
    theme: coerce(input.theme, THEMES, DEFAULT_SETTINGS.theme),
    font: coerce(input.font, FONTS, DEFAULT_SETTINGS.font),
    textSize: coerce(input.textSize, TEXT_SIZES, DEFAULT_SETTINGS.textSize),
    width: coerce(input.width, WIDTHS, DEFAULT_SETTINGS.width),
    density: coerce(input.density, DENSITIES, DEFAULT_SETTINGS.density),
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

export function applyAppearance(settings: UserSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--dial-font", FONT_STACKS[settings.font]);
  root.style.setProperty("--dial-text-scale", TEXT_SCALE[settings.textSize]);
  root.style.setProperty("--dial-column", COLUMN_WIDTH[settings.width]);
  root.style.setProperty("--dial-row-gap", ROW_GAP[settings.density]);
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

const LOCAL_KEY = "dial:settings";

/**
 * A device-local mirror, so appearance survives a reload without waiting on
 * the network and the app never flashes the wrong theme while a request is
 * in flight. The cloud copy is authoritative on conflict.
 */
export function readLocal(): UserSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeLocal(settings: UserSettings): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(settings));
  } catch {
    // Storage disabled — settings live for this session only.
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
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
  records: number;
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
  return {
    settings: opened ? normalizeSettings(opened) : null,
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
): Promise<void> {
  if (accountEncrypted && !kek) throw new WouldDowngradeError();

  const body = kek
    ? {
        settings: await sealRecord(kek, SETTINGS_RECORD_ID, settings),
        encryption: "password" as const,
      }
    : { settings: JSON.stringify(settings) };

  const response = await fetch("/v1/state", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`could not save settings (${response.status})`);
}

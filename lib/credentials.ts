"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The OpenRouter credential — the first secret this app holds on a user's
 * behalf, and the reason the server can leave the token path entirely.
 *
 * Since the key belongs to the *user*, not the operator, it lives in the
 * browser and talks to OpenRouter directly. Nothing here ever reaches a
 * server of ours; there is no server of ours in this path.
 *
 * ## Why this is an interface and not three localStorage calls
 *
 * The storage location is going to move. Today the credential is
 * device-local. Once accounts exist it should follow the user across
 * devices, which means living inside the encrypted vault — ciphertext on
 * our side, readable only by a key we never see. That is a change of
 * *backing store*, not of behaviour, so callers talk to `CredentialStore`
 * and never touch storage directly.
 *
 * The planned identity modes, so the seam is shaped for all three:
 *
 *  - **token** — a single high-entropy string the user saves. It is both
 *    the account identifier (hashed server-side) and the vault key
 *    (derived, never transmitted). No email, no password, no PII at rest.
 *  - **password** — split derivation: one Argon2id pass, an auth half sent
 *    to the server and an encryption half that stays here.
 *  - **oauth (Google)** — proves *who* you are but yields no key material,
 *    so it must be paired with a token or a device-linking handshake to
 *    unlock the vault.
 *
 * All three end up calling `write()` with the same `Credential`. Only the
 * implementation behind the interface differs.
 */

const STORAGE_KEY = "dial:credential";

/** How the key got here. Kept so the UI can explain what "disconnect" does. */
export type CredentialSource = "oauth" | "manual";

export type Credential = {
  /** The OpenRouter API key. Sent to openrouter.ai and nowhere else. */
  key: string;
  source: CredentialSource;
  /** OpenRouter's own label for the key, when the exchange reports one. */
  label: string | null;
  connectedAt: number;
};

export interface CredentialStore {
  read(): Credential | null;
  write(credential: Credential): void;
  clear(): void;
  /** Notify on change, including writes from another tab. */
  subscribe(onChange: () => void): () => void;
}

/** OpenRouter keys are `sk-or-v1-…`; reject anything that clearly isn't one. */
export function looksLikeKey(value: string): boolean {
  return /^sk-or-v1-[A-Za-z0-9._-]{16,256}$/.test(value.trim());
}

/** Last four characters, for showing which key is connected without showing it. */
export function keyFingerprint(key: string): string {
  return `…${key.slice(-4)}`;
}

function parse(raw: string | null): Credential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Credential>;
    if (typeof parsed.key !== "string" || !parsed.key) return null;
    return {
      key: parsed.key,
      source: parsed.source === "oauth" ? "oauth" : "manual",
      label: typeof parsed.label === "string" ? parsed.label : null,
      connectedAt:
        typeof parsed.connectedAt === "number" ? parsed.connectedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * `useSyncExternalStore` compares snapshots by identity, so re-parsing JSON
 * on every read would hand it a new object each time and spin forever. The
 * parsed value is cached against the raw string it came from and only
 * rebuilt when that string actually changes.
 */
let cache: { raw: string | null; value: Credential | null } = {
  raw: null,
  value: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const localCredentialStore: CredentialStore = {
  read() {
    if (typeof window === "undefined") return null;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage blocked (private mode, embedded context) — treat as absent.
      return null;
    }
    if (raw !== cache.raw) cache = { raw, value: parse(raw) };
    return cache.value;
  },

  write(credential) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(credential));
    } catch {
      // Fall through: the in-memory cache below still serves this session.
    }
    cache = { raw: JSON.stringify(credential), value: credential };
    emit();
  },

  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do — the cache reset below is what the UI reads.
    }
    cache = { raw: null, value: null };
    emit();
  },

  subscribe(onChange) {
    listeners.add(onChange);
    // A second tab connecting or disconnecting should settle this one too.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      cache = { raw: null, value: null };
      onChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  },
};

/** The server render has no storage to read, so it always sees "not connected". */
function serverSnapshot(): Credential | null {
  return null;
}

/**
 * Subscribe a component to the credential.
 *
 * Anything gated on this must also respect that the first client render
 * matches the server's `null` — render the gate, not a flash of the app.
 */
export function useCredential(): {
  credential: Credential | null;
  connect: (credential: Credential) => void;
  disconnect: () => void;
} {
  const credential = useSyncExternalStore(
    localCredentialStore.subscribe,
    localCredentialStore.read,
    serverSnapshot,
  );

  const connect = useCallback((next: Credential) => {
    localCredentialStore.write(next);
  }, []);

  const disconnect = useCallback(() => {
    localCredentialStore.clear();
  }, []);

  return { credential, connect, disconnect };
}

/**
 * Imperative read, for call sites that are not components — the chat
 * transport, the title generator, the image tool. Always read at call time:
 * a key captured in a closure survives a disconnect.
 */
export function currentKey(): string | null {
  return localCredentialStore.read()?.key ?? null;
}

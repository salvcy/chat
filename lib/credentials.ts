"use client";

import { useSyncExternalStore } from "react";

/**
 * The OpenRouter credential — the first secret this app holds on a user's
 * behalf, and the reason the server can leave the token path entirely.
 *
 * Since the key belongs to the *user*, not the operator, the browser talks to
 * OpenRouter directly. Nothing here ever reaches a server of ours; there is
 * no server of ours in this path.
 *
 * ## Where it lives now
 *
 * In memory, and nowhere else on this device.
 *
 * This file used to be an interface over `localStorage`, with a doc comment
 * promising that the backing store was going to move into the encrypted vault
 * once accounts existed. Accounts exist, so it has. The key is one field of
 * the sealed settings blob: ciphertext on our side, readable only with a key
 * derived from a password we never receive, and present on every device the
 * user signs in from instead of just the one they pasted it into.
 *
 * That closes the worst thing in this app's storage. `dial:credential` held a
 * billable API key as plaintext on disk, readable by any script that ever ran
 * on the origin and by anyone with the profile directory. Now it exists in a
 * tab's heap for as long as that tab is open.
 *
 * `lib/session.ts` owns the lifecycle and calls `setCredential` when the blob
 * is read or written. Everything else reads through here.
 */

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

/** OpenRouter keys are `sk-or-v1-…`; reject anything that clearly isn't one. */
export function looksLikeKey(value: string): boolean {
  return /^sk-or-v1-[A-Za-z0-9]{16,}$/.test(value.trim());
}

/**
 * A short, stable fingerprint for display. Never the key itself: the settings
 * panel has to be able to say *which* key is connected without putting one on
 * screen for a shoulder or a screenshot to collect.
 */
export function keyFingerprint(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 12
    ? trimmed
    : `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

/* ------------------------------ the holder ----------------------------- */

let current: Credential | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function snapshot(): Credential | null {
  return current;
}

/**
 * Adopt the key from the account's settings, or drop it.
 *
 * Called by `lib/session.ts` — once when the sealed blob is opened, and again
 * whenever it changes. Identical values are ignored so a settings refresh
 * that changed something else cannot re-render every consumer of the key.
 */
export function setCredential(next: Credential | null): void {
  if (current?.key === next?.key && current?.source === next?.source) return;
  current = next;
  emit();
}

/**
 * Subscribe a component to the credential.
 *
 * The server render has no key, so the first client render must agree with
 * it — anything gated on this renders the gate, never a flash of the app.
 */
export function useCredential(): Credential | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * Imperative read, for call sites that are not components — the chat
 * transport, the title generator, the image tool. Always read at call time:
 * a key captured in a closure survives a disconnect.
 */
export function currentKey(): string | null {
  return current?.key ?? null;
}

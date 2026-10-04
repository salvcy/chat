"use client";

import type { Credential } from "./credentials";

/**
 * OpenRouter OAuth PKCE — "connect your account" instead of "paste a key".
 *
 * The user authorizes on openrouter.ai and comes back with a code we trade
 * for a key scoped to this app. Two things that matters for:
 *
 *  - Nobody has to find, copy, or handle a raw secret, so the key never
 *    passes through a clipboard, a password manager, or a screenshot.
 *  - The resulting key is revocable from their OpenRouter dashboard without
 *    touching the key they use everywhere else, and can carry its own
 *    credit limit.
 *
 * PKCE (rather than a plain code exchange) is what makes this safe with no
 * server: there is no client secret to hide, because possession of the
 * one-time verifier is the proof. The verifier never leaves this tab.
 *
 * @see https://openrouter.ai/docs/use-cases/oauth-pkce
 */

const AUTH_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const VERIFIER_KEY = "dial:pkce-verifier";

/** RFC 7636 base64url: standard base64, `+/` swapped out, padding dropped. */
function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(digest);
}

/**
 * The exact URL OpenRouter must send the user back to. Query and hash are
 * stripped: the callback has to match what we registered in the request,
 * and we append our own `?code=` on return.
 */
export function callbackUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Start the flow. Redirects the tab, so nothing after this runs.
 *
 * The verifier goes to sessionStorage rather than localStorage on purpose:
 * it is single-use, scoped to this tab, and gone when the tab closes.
 */
export async function beginConnect(): Promise<void> {
  const verifier = createVerifier();
  const challenge = await challengeOf(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const url = new URL(AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
}

/** The `?code=` OpenRouter appends on the way back, if this is a return trip. */
export function pendingCode(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("code");
}

/**
 * Drop `?code=` from the address bar.
 *
 * Authorization codes are single-use, so leaving it in the URL means a
 * reload retries a spent code and shows a failure for something that
 * already succeeded. It also keeps the code out of the user's history.
 */
export function clearCodeFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("code")) return;
  url.searchParams.delete("code");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export class ConnectError extends Error {
  constructor(
    message: string,
    /** True when the user can fix this by retrying; false when it's terminal. */
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/** Trade the code for a key. Consumes the stored verifier either way. */
export async function completeConnect(code: string): Promise<Credential> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  if (!verifier) {
    throw new ConnectError(
      "this tab did not start the connection — try again, or paste a key instead",
    );
  }

  let response: Response;
  try {
    response = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
  } catch {
    throw new ConnectError("could not reach OpenRouter — check your connection");
  }

  const payload = (await response.json().catch(() => null)) as {
    key?: string;
    error?: string | { message?: string };
  } | null;

  if (!response.ok || !payload?.key) {
    const detail =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message;
    throw new ConnectError(
      detail ?? `OpenRouter rejected the exchange (${response.status})`,
      // Codes expire after ten minutes; a fresh attempt is the fix.
      response.status !== 401,
    );
  }

  return {
    key: payload.key,
    source: "oauth",
    label: null,
    connectedAt: Date.now(),
  };
}

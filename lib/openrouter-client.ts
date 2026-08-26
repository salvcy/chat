"use client";

import {
  createOpenRouter,
  type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";

/**
 * The browser's OpenRouter provider — the replacement for the server-only
 * factory this app used to build inside route handlers.
 *
 * OpenRouter serves `Access-Control-Allow-Origin: *` and allow-lists the
 * `Authorization`, `HTTP-Referer` and `X-Title` headers, so the browser can
 * stream completions from it directly. That is the whole basis of this
 * architecture: the model stream never touches a server we pay for, which
 * means an eight-minute reasoning answer costs us nothing and cannot hit a
 * function timeout.
 *
 * The key is the user's own. It is not a secret being leaked to the client —
 * the client is where it belongs.
 */

const APP_NAME = "Chat";

/**
 * Rebuilding the provider per turn would discard its internal fetch setup on
 * every message, so it is cached against the key it was built for and
 * replaced only when the user connects a different one.
 */
let cached: { key: string; provider: OpenRouterProvider } | null = null;

export function providerFor(key: string): OpenRouterProvider {
  if (cached?.key === key) return cached.provider;
  const provider = createOpenRouter({
    apiKey: key,
    appName: APP_NAME,
    // Attribution on the OpenRouter dashboard. `HTTP-Referer` is a custom
    // header name (not the browser's protected `Referer`), so setting it
    // from a page is allowed and it survives the preflight allow-list.
    appUrl: window.location.origin,
  });
  cached = { key, provider };
  return provider;
}

/** Thrown before a request is built, so the UI can prompt for a key. */
export class MissingKeyError extends Error {
  constructor() {
    super("Connect an OpenRouter key to start a conversation.");
    this.name = "MissingKeyError";
  }
}

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** Shared auth headers for the endpoints called with plain `fetch`. */
export function authHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": window.location.origin,
    "X-Title": APP_NAME,
  };
}

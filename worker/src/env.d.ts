/// <reference types="@cloudflare/workers-types" />

/**
 * Worker bindings.
 *
 * This file used to hand-declare a handful of D1 methods so the Worker could
 * stay dependency-free. Better Auth brought the real types package with it,
 * so the hand-rolled shims are gone — keeping them would have meant two
 * definitions of `D1Database` disagreeing with each other.
 */
export interface Env {
  DB: D1Database;

  /** Signs session cookies. `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET: string;

  /** Google OAuth. The client id is public; the secret is not. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  /**
   * Wraps sensitive per-user fields (notably the OpenRouter key) for accounts
   * that have not turned on end-to-end encryption. It is a real key that we
   * hold, so it is defence in depth rather than a privacy guarantee: a D1
   * dump alone does not yield anyone's API key, but we could still read one.
   */
  DATA_KEY: string;
}

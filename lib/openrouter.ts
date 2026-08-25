import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { DEFAULT_MODEL } from "./types";

/**
 * The one place the OpenRouter provider is constructed.
 *
 * The API key is server-only (OPENROUTER_API_KEY, never NEXT_PUBLIC_*), so
 * this module must only ever be imported from route handlers. `appName` /
 * `appUrl` become the HTTP-Referer + X-Title headers OpenRouter uses to
 * attribute requests on the dashboard.
 *
 * Per-request concerns — the reasoning param, the web_search server tool,
 * usage accounting — are passed at the `streamText` call site in
 * app/api/chat/route.ts, not baked in here.
 */
export const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  appName: "Chat",
  appUrl: process.env.OPENROUTER_APP_URL ?? "http://localhost:3000",
});

export { DEFAULT_MODEL };

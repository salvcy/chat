import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { DEFAULT_MODEL } from "./types";

/**
 * OpenRouter provider instance. The API key is server-only
 * (OPENROUTER_API_KEY, never NEXT_PUBLIC_*).
 *
 * Phase 3 slots in here: the `reasoning` param and the
 * `openrouter:web_search` server tool are added to the streamText
 * call in app/api/chat/route.ts — no refactor of this file needed.
 */
export const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  appName: "Dial",
  appUrl: "https://github.com/ahmed/dial",
});

export { DEFAULT_MODEL };

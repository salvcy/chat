"use client";

import { generateText } from "ai";
import { currentKey } from "./credentials";
import { providerFor } from "./openrouter-client";
import { DEFAULT_TITLE_MODEL } from "./types";

/**
 * Name a conversation with a cheap fast model.
 *
 * `deriveTitle` slices the first line of the opening message, which turns a
 * pasted stack trace into an unreadable sidebar row. This reads the exchange
 * and names it instead.
 *
 * Best-effort by construction: every failure path returns null and the
 * caller keeps its local fallback. Naming is a nicety, and it must never be
 * able to fail a save or block a turn.
 */

const SYSTEM = [
  "You name chat conversations.",
  "Reply with a title of 2-5 words describing the topic.",
  "No quotes, no trailing punctuation, no preamble.",
  "Use sentence case. Never answer the question itself.",
].join(" ");

/** Strip the things small models add anyway: quotes, periods, "Title:". */
function clean(raw: string): string {
  return raw
    .trim()
    .split("\n")[0]
    .replace(/^(title|topic)\s*[:—-]\s*/i, "")
    .replace(/^["'“”‘’]|["'“”‘’.]+$/g, "")
    .trim()
    .slice(0, 60);
}

export async function generateTitle({
  prompt,
  reply,
  signal,
}: {
  prompt: string;
  reply?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const key = currentKey();
  if (!key) return null;

  try {
    const { text } = await generateText({
      model: providerFor(key)(DEFAULT_TITLE_MODEL),
      system: SYSTEM,
      prompt: reply
        ? `User: ${prompt.slice(0, 2000)}\n\nAssistant: ${reply.slice(0, 600)}`
        : `User: ${prompt.slice(0, 2000)}`,
      maxOutputTokens: 24,
      temperature: 0.2,
      abortSignal: signal,
    });
    return clean(text) || null;
  } catch {
    return null;
  }
}

"use client";

import Dexie, { type Table } from "dexie";
import type { UIMessage } from "ai";
import type { ReasoningEffort } from "./types";

/**
 * Local-first storage: IndexedDB via Dexie, entirely client-side.
 * Two tables — conversations (metadata) and messages (UIMessage parts).
 */
export type ConversationMeta = {
  id: string;
  title: string;
  /** OpenRouter model id — persisted per conversation. */
  model: string;
  reasoning: ReasoningEffort;
  search: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StoredMessage = UIMessage & {
  conversationId: string;
};

export class DialDB extends Dexie {
  conversations!: Table<ConversationMeta, string>;
  messages!: Table<StoredMessage, string>;

  constructor() {
    super("dial");
    this.version(1).stores({
      conversations: "id, updatedAt",
      messages: "id, conversationId",
    });
  }
}

export const db = new DialDB();

/** First user text of a conversation, truncated — the display title. */
export function deriveTitle(messages: Array<{ role: string; parts: unknown }>): string {
  const first = messages
    .map((m) => {
      if (m.role !== "user" || !Array.isArray(m.parts)) return "";
      return (
        (m.parts as Array<{ type: string; text?: string }>).find(
          (p) => p.type === "text",
        )?.text ?? ""
      );
    })
    .find((t) => t.trim().length > 0);
  return (first ?? "new chat").slice(0, 80) || "new chat";
}

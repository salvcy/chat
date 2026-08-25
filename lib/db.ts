"use client";

import Dexie, { type Table } from "dexie";
import type { UIMessage } from "ai";
import {
  DEFAULT_SETTINGS,
  type ChatSettings,
  type DialDataParts,
  type DialMetadata,
  type ReasoningEffort,
} from "./types";

/**
 * Local-first storage: IndexedDB via Dexie, entirely client-side.
 *
 * v2 adds three things v1 couldn't express: a per-conversation system
 * prompt, pinning, and the rolling cost/token totals that make the sidebar
 * and status strip able to show what a thread has actually spent.
 */

export type ConversationMeta = {
  id: string;
  title: string;
  /** True once a model has named it — stops the fallback from overwriting. */
  titleGenerated?: boolean;
  /** OpenRouter model id — persisted per conversation. */
  model: string;
  reasoning: ReasoningEffort;
  search: boolean;
  /** Per-conversation system prompt. "" = none. */
  system: string;
  /** Pinned threads sort above everything else. */
  pinned?: boolean;
  /** Rolling totals across the thread, summed from message metadata. */
  totalCostUsd?: number;
  totalTokens?: number;
  createdAt: number;
  updatedAt: number;
};

/** A stored message carries its flight recorder, so reopening shows it. */
export type StoredMessage = UIMessage<DialMetadata, DialDataParts> & {
  conversationId: string;
  /** Position in the thread — IndexedDB gives no insertion-order guarantee. */
  seq: number;
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

    // v2: compound index for ordered thread reads, plus the new meta fields.
    this.version(2)
      .stores({
        conversations: "id, updatedAt, pinned",
        messages: "id, conversationId, [conversationId+seq]",
      })
      .upgrade(async (tx) => {
        await tx
          .table<ConversationMeta>("conversations")
          .toCollection()
          .modify((c) => {
            c.system ??= "";
            c.pinned ??= false;
          });
        // Existing rows predate `seq`; fall back to stored order per thread.
        const counters = new Map<string, number>();
        await tx
          .table<StoredMessage>("messages")
          .toCollection()
          .modify((m) => {
            const next = counters.get(m.conversationId) ?? 0;
            m.seq ??= next;
            counters.set(m.conversationId, next + 1);
          });
      });
  }
}

export const db = new DialDB();

/** Plain-text of a message, across its text parts. */
export function textOf(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

/**
 * Local fallback title — first user line, tightened. Used immediately so the
 * sidebar is never blank, then replaced by /api/title when that returns.
 */
export function deriveTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first ? textOf(first) : "";
  if (!text) return "new chat";
  // Collapse whitespace so a pasted block doesn't become a ragged row.
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Sum the flight recorders on a thread into its rolling totals. */
export function totalsOf(messages: UIMessage<DialMetadata>[]): {
  totalCostUsd: number;
  totalTokens: number;
} {
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const m of messages) {
    const meta = m.metadata;
    if (!meta) continue;
    totalCostUsd += meta.costUsd ?? 0;
    totalTokens += (meta.promptTokens ?? 0) + (meta.completionTokens ?? 0);
  }
  return { totalCostUsd, totalTokens };
}

export function settingsOf(meta: ConversationMeta | undefined): ChatSettings {
  if (!meta) return { ...DEFAULT_SETTINGS };
  return {
    model: meta.model,
    reasoning: meta.reasoning,
    search: meta.search,
    system: meta.system ?? "",
  };
}

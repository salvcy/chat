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
 * Local-first storage: IndexedDB via Dexie. This is the source of truth —
 * cloud sync (v3) is a replica of it, not the other way round.
 *
 * v2 adds three things v1 couldn't express: a per-conversation system
 * prompt, pinning, and the rolling cost/token totals that make the sidebar
 * and status strip able to show what a thread has actually spent.
 *
 * v3 adds the columns the sync engine needs. Two are on every row:
 *
 *  - `dirty` — 1 when the row has local changes the server has not
 *    acknowledged. Numeric rather than boolean because IndexedDB cannot
 *    index booleans, which is the kind of thing you find out by having a
 *    query silently return nothing.
 *  - `rev` — the account revision this row was last confirmed at.
 *
 * …and one is a table: `tombstones`. A deleted row cannot carry a flag
 * saying it was deleted, so the deletion has to be recorded somewhere that
 * survives it. Without this, deleting a conversation on one device and then
 * syncing would look exactly like that device simply not having it yet, and
 * the next pull would helpfully restore it.
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
  /** 1 when there are local changes the server hasn't acknowledged. */
  dirty?: number;
  /** Strictly increasing marker of the last local write. See `stamp()`. */
  stamp?: number;
  /** Account revision this row was last confirmed at. 0 = never synced. */
  rev?: number;
};

/** A stored message carries its flight recorder, so reopening shows it. */
export type StoredMessage = UIMessage<DialMetadata, DialDataParts> & {
  conversationId: string;
  /** Position in the thread — IndexedDB gives no insertion-order guarantee. */
  seq: number;
  dirty?: number;
  stamp?: number;
  rev?: number;
};

/**
 * A record deleted locally that the server has not been told about yet.
 *
 * Conversations and messages share one id space upstream (both are uuids),
 * so one flat table covers both. Rows are removed once the deletion has
 * been pushed.
 */
export type Tombstone = {
  id: string;
  deletedAt: number;
};

/**
 * The vault key, persisted across reloads.
 *
 * A session cookie keeps someone signed in for thirty days, but the key can
 * only be derived from a password they typed once. Storing the `CryptoKey`
 * object itself is what bridges that gap: IndexedDB structured-clones it, the
 * browser hands it back usable, and because it is non-extractable there is no
 * byte sequence for injected script to steal. Script on this page can use the
 * vault; it cannot carry it away.
 *
 * The password is never stored, in any form.
 */
export type VaultSession = {
  id: "session";
  dek: CryptoKey;
};

export class DialDB extends Dexie {
  conversations!: Table<ConversationMeta, string>;
  messages!: Table<StoredMessage, string>;
  tombstones!: Table<Tombstone, string>;
  vault!: Table<VaultSession, string>;

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

    // v3: sync bookkeeping.
    this.version(3)
      .stores({
        conversations: "id, updatedAt, pinned, dirty",
        messages: "id, conversationId, [conversationId+seq], dirty",
        tombstones: "id, deletedAt",
        vault: "id",
      })
      .upgrade(async (tx) => {
        // Everything that already exists predates sync, so it has never been
        // uploaded. Marking it dirty is what makes enabling sync on an
        // established install push the whole history up rather than start
        // from the next message.
        await tx
          .table<ConversationMeta>("conversations")
          .toCollection()
          .modify((c) => {
            c.dirty = 1;
            c.stamp = c.updatedAt;
            c.rev = 0;
          });
        await tx
          .table<StoredMessage>("messages")
          .toCollection()
          .modify((m) => {
            m.dirty = 1;
            m.stamp = 1;
            m.rev = 0;
          });
      });

    // v4: R2 blob references. Existing local pixels need one more sync so
    // they are uploaded instead of remaining stranded on the device that
    // created them. Rows whose bytes were already stripped elsewhere are
    // harmlessly included; the sync engine simply has nothing to upload.
    this.version(4)
      .stores({
        conversations: "id, updatedAt, pinned, dirty",
        messages: "id, conversationId, [conversationId+seq], dirty",
        tombstones: "id, deletedAt",
        vault: "id",
      })
      .upgrade(async (tx) => {
        await tx
          .table<StoredMessage>("messages")
          .toCollection()
          .modify((message) => {
            const hasLocalBlob = message.parts.some(
              (part) =>
                (part.type === "data-image" &&
                  part.data.images.some(
                    (image) => image.url.startsWith("data:") && !image.blobId,
                  )) ||
                (part.type === "file" && part.url.startsWith("data:")),
            );
            if (!hasLocalBlob) return;
            message.dirty = 1;
            message.stamp = stamp();
          });
      });
  }
}

export const db = new DialDB();

/**
 * A strictly increasing marker written on every local mutation.
 *
 * The sync engine reads dirty rows, encrypts and uploads them, and only then
 * clears the flag — but a streaming turn writes a snapshot every 1.2s, so a
 * row can be rewritten while its own upload is in flight. Clearing `dirty`
 * blind at that point would strand the newer write forever. Comparing the
 * stamp captured before the upload against the row afterwards makes that
 * race visible: unchanged means it is safe to clear, changed means leave it
 * dirty and let the next pass carry it.
 *
 * `Date.now()` alone is not enough because two writes can share a
 * millisecond, so the counter steps forward when the clock does not.
 */
let lastStamp = 0;

export function stamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Dexie from "dexie";
import type { UIMessage } from "ai";
import {
  db,
  deriveTitle,
  stamp,
  textOf,
  totalsOf,
  type ConversationMeta,
  type StoredMessage,
} from "./db";
import { generateTitle } from "./title";
import type { ChatSettings, DialDataParts, DialMetadata } from "./types";

export type DialMessage = UIMessage<DialMetadata, DialDataParts>;

/**
 * Conversation store over Dexie.
 *
 * Two behaviours matter beyond CRUD:
 *
 *  1. `saveTurn` reconciles rather than appends. Editing or regenerating
 *     truncates the thread, so any message no longer present is deleted —
 *     without this, IndexedDB accumulates orphans that reappear on reload
 *     as duplicated branches.
 *
 *  2. Titles are generated, not sliced. A local fallback lands immediately
 *     so the sidebar is never blank, then a cheap model replaces it once.
 *     The call is fire-and-forget: it can never block or fail a save.
 */
/**
 * How long a streaming thread waits between *cloud* pushes.
 *
 * The 1.2s snapshot exists for local durability and stays at 1.2s — losing a
 * long answer to a closed tab is the thing it prevents. Pushing that snapshot
 * to D1 at the same rate is a different question: another device only needs
 * the answer to visibly progress, and paying a row write every 1.2s for that
 * is most of this app's entire server cost. Six seconds still reads as live
 * on the other device and costs a tenth as much.
 */
const DRAFT_SYNC_MS = 5000;

/**
 * Cheap identity of a message, used to decide whether a row is worth
 * rewriting. Covers everything that actually moves in this app: text growing
 * during a stream, a part appearing, the flight recorder being attached at
 * finish, and a message changing position after an edit.
 *
 * Deliberately not a deep compare of the whole row. It runs over the entire
 * thread on every snapshot, and it must not read fields the sync engine adds
 * behind React's back — `blobId` and friends live inside `parts`, so
 * stringifying them here would make every message look changed the moment its
 * image was uploaded, and the upload would then repeat forever.
 */
function mix(hash: number, value: string): number {
  let h = hash;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(h, 33) ^ value.charCodeAt(i)) >>> 0;
  }
  // A separator, so ["ab","c"] and ["a","bc"] cannot collide.
  return (Math.imul(h, 33) ^ 0x1f) >>> 0;
}

function contentKey(
  message: {
    id: string;
    role: string;
    parts: unknown[];
    metadata?: unknown;
  },
  seq: number,
): string {
  let h = mix(mix(mix(5381, message.id), String(seq)), message.role);

  for (const part of message.parts as Record<string, unknown>[]) {
    h = mix(h, String(part.type));

    // Text and reasoning are where all the movement is, and they are what a
    // same-length edit would otherwise hide, so they are hashed in full.
    if (typeof part.text === "string") {
      h = mix(h, part.text);
      continue;
    }

    // Attachments and generated images are written once and never mutated,
    // so their size stands in for their bytes. Hashing megabytes of base64
    // every 1.2s would cost more than the writes this is here to save — and
    // reading into them would pick up the blob ids the sync engine adds,
    // which is exactly what must not count as a change.
    if (typeof part.url === "string") {
      h = mix(mix(h, String(part.mediaType ?? "")), String(part.url.length));
      continue;
    }
    if (part.type === "data-image") {
      const data = part.data as { images?: { mediaType: string; url: string }[] };
      for (const image of data?.images ?? []) {
        h = mix(mix(h, image.mediaType), String(image.url.length));
      }
      continue;
    }

    h = mix(h, JSON.stringify(part));
  }

  return String(mix(h, JSON.stringify(message.metadata ?? null)));
}


export function useConversations() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * Bumped by local mutations only — never by `reload`.
   *
   * The sync engine watches this to know when there is something worth
   * pushing. Watching the conversation array instead would feed back on
   * itself: a pull writes rows, `reload` replaces the array, and that would
   * read as a fresh local change and schedule another sync forever.
   */
  const [localWrites, setLocalWrites] = useState(0);
  const touch = useCallback(() => setLocalWrites((n) => n + 1), []);
  /** Threads already sent for naming this session — one request each. */
  const namingRef = useRef(new Set<string>());
  /** When a streaming thread last scheduled a cloud push. See DRAFT_SYNC_MS. */
  const lastDraftPushRef = useRef(0);

  const reload = useCallback(async () => {
    const rows = await db.conversations.orderBy("updatedAt").reverse().toArray();
    // Pinned first, then most-recent — Dexie can't express that in one index.
    rows.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    setConversations(rows);
    return rows;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await reload();
      if (cancelled) return;
      const saved = localStorage.getItem("dial:active");
      setActiveIdState(rows.some((r) => r.id === saved) ? saved : null);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem("dial:active", id);
    else localStorage.removeItem("dial:active");
  }, []);

  /** Ask a cheap model to name the thread. Best-effort, never blocking. */
  const nameThread = useCallback(
    async (id: string, messages: DialMessage[]) => {
      if (namingRef.current.has(id)) return;
      const prompt = messages.find((m) => m.role === "user");
      const reply = messages.find((m) => m.role === "assistant");
      if (!prompt) return;
      const promptText = textOf(prompt);
      if (!promptText) return;
      namingRef.current.add(id);

      const title = await generateTitle({
        prompt: promptText,
        reply: reply ? textOf(reply) : undefined,
      });
      // Null covers every failure path, including no key connected. The
      // locally derived title stays, which is the whole fallback plan.
      if (!title) return;

      // Only if the row still exists and hasn't been renamed by hand.
      const current = await db.conversations.get(id);
      if (!current || current.titleGenerated) return;
      await db.conversations.update(id, { title, titleGenerated: true });
      await reload();
    },
    [reload],
  );

  /**
   * Write the whole thread. `messages` is the authoritative state — rows in
   * the table that aren't in it are removed.
   */
  const saveTurn = useCallback(
    async ({
      id,
      settings,
      messages,
      naming = true,
      draft = false,
    }: {
      id: string;
      settings: ChatSettings;
      messages: DialMessage[];
      /** False while streaming — don't name a half-finished thread. */
      naming?: boolean;
      /** A mid-stream snapshot: always stored, pushed on a slower clock. */
      draft?: boolean;
    }) => {
      if (messages.length === 0) return;

      const existing = await db.conversations.get(id);
      const { totalCostUsd, totalTokens } = totalsOf(messages);
      const now = Date.now();

      const meta: ConversationMeta = {
        id,
        title: existing?.title ?? deriveTitle(messages),
        titleGenerated: existing?.titleGenerated ?? false,
        model: settings.model,
        reasoning: settings.reasoning,
        search: settings.search,
        system: settings.system,
        pinned: existing?.pinned ?? false,
        totalCostUsd,
        totalTokens,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        // Every local write is unsynced until the engine says otherwise.
        dirty: 1,
        stamp: stamp(),
        rev: existing?.rev ?? 0,
      };

      /*
       * Only rewrite the messages that actually changed.
       *
       * This used to mark the entire thread dirty on every save, so one turn
       * in a fifty-message conversation queued fifty records for upload — and
       * the mid-stream snapshot did it again every 1.2 seconds. A single long
       * answer could cost a couple of thousand row writes, which is most of a
       * free tier for one reply. In practice one message changes per save,
       * and leaving the rest untouched also preserves the R2 blob references
       * the sync engine wrote into them, so images stop being re-uploaded.
       */
      const stored = await db.messages
        .where("conversationId")
        .equals(id)
        .toArray();
      const priorById = new Map(stored.map((row) => [row.id, row]));

      const rows: StoredMessage[] = [];
      messages.forEach((m, seq) => {
        const prior = priorById.get(m.id);
        if (prior && contentKey(prior, prior.seq) === contentKey(m, seq)) return;
        rows.push({ ...m, conversationId: id, seq, dirty: 1, stamp: stamp() });
      });

      // Every message in the turn, not just the rewritten ones — otherwise
      // the reconcile below would delete the ones we deliberately skipped.
      const keep = new Set(messages.map((m) => m.id));

      await db.transaction(
        "rw",
        db.conversations,
        db.messages,
        db.tombstones,
        async () => {
          await db.conversations.put(meta);
          const stale = await db.messages
            .where("conversationId")
            .equals(id)
            .primaryKeys();
          const drop = stale.filter((key) => !keep.has(key));
          if (drop.length > 0) {
            await db.messages.bulkDelete(drop);
            // Truncating on edit/regenerate is a real deletion upstream too.
            // Without tombstones the next pull would restore the branch that
            // was just cut off.
            await db.tombstones.bulkPut(
              drop.map((key) => ({ id: String(key), deletedAt: now })),
            );
          }
          if (rows.length > 0) await db.messages.bulkPut(rows);
        },
      );

      await reload();

      // A draft schedules a cloud push at most every DRAFT_SYNC_MS. The rows
      // are already in Dexie either way, so a skipped push costs nothing but
      // a few seconds of staleness on another device.
      if (draft) {
        const now = Date.now();
        if (now - lastDraftPushRef.current >= DRAFT_SYNC_MS) {
          lastDraftPushRef.current = now;
          touch();
        }
      } else {
        lastDraftPushRef.current = 0;
        touch();
      }

      if (naming && !meta.titleGenerated && messages.length >= 2) {
        void nameThread(id, messages);
      }
    },
    [reload, nameThread, touch],
  );

  const loadMessages = useCallback(
    async (conversationId: string): Promise<DialMessage[]> => {
      // Read through the compound index so the thread comes back in the
      // order it was written — IndexedDB guarantees nothing otherwise.
      const rows = await db.messages
        .where("[conversationId+seq]")
        .between(
          [conversationId, Dexie.minKey],
          [conversationId, Dexie.maxKey],
        )
        .toArray();
      // Strip the storage-only columns before handing rows to useChat.
      return rows.map((row) => {
        const message = { ...row } as Partial<StoredMessage>;
        delete message.conversationId;
        delete message.seq;
        return message as DialMessage;
      });
    },
    [],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      // A hand-typed name is final — stop the generator from replacing it.
      await db.conversations.update(id, {
        title,
        titleGenerated: true,
        dirty: 1,
        stamp: stamp(),
      });
      await reload();
      touch();
    },
    [reload, touch],
  );

  const remove = useCallback(
    async (id: string) => {
      const now = Date.now();
      await db.transaction(
        "rw",
        db.conversations,
        db.messages,
        db.tombstones,
        async () => {
          const messageIds = await db.messages
            .where("conversationId")
            .equals(id)
            .primaryKeys();
          await db.conversations.delete(id);
          await db.messages.where("conversationId").equals(id).delete();
          await db.tombstones.bulkPut(
            [id, ...messageIds.map(String)].map((key) => ({
              id: key,
              deletedAt: now,
            })),
          );
        },
      );
      await reload();
      touch();
      setActiveIdState((current) => {
        if (current !== id) return current;
        localStorage.removeItem("dial:active");
        return null;
      });
    },
    [reload, touch],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const row = await db.conversations.get(id);
      if (!row) return;
      await db.conversations.update(id, {
        pinned: !row.pinned,
        dirty: 1,
        stamp: stamp(),
      });
      await reload();
      touch();
    },
    [reload, touch],
  );

  /** Persist a settings change on a thread that may not exist yet. */
  const updateSettings = useCallback(
    async (id: string, patch: Partial<ChatSettings>) => {
      const row = await db.conversations.get(id);
      if (!row) return;
      await db.conversations.update(id, {
        ...patch,
        updatedAt: Date.now(),
        dirty: 1,
        stamp: stamp(),
      });
      await reload();
      touch();
    },
    [reload, touch],
  );

  const getMeta = useCallback(
    async (id: string) => db.conversations.get(id),
    [],
  );

  return {
    conversations,
    activeId,
    setActiveId,
    ready,
    /** Increments on local mutations; the sync engine's change signal. */
    localWrites,
    /** Re-read from Dexie — call after a pull has written rows. */
    reload,
    saveTurn,
    loadMessages,
    rename,
    remove,
    togglePin,
    updateSettings,
    getMeta,
  };
}

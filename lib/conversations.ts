"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import {
  deleteThread,
  deriveTitle,
  listThreads,
  readThread,
  textOf,
  totalsOf,
  writeThread,
  type ConversationMeta,
  type StoredMessage,
} from "./store";
import { generateTitle } from "./title";
import type { ChatSettings, DialDataParts, DialMetadata } from "./types";

export type DialMessage = UIMessage<DialMetadata, DialDataParts>;

/**
 * The conversation store, over the cloud.
 *
 * The surface is deliberately unchanged from the Dexie version — the same
 * thirteen members with the same signatures — because `app/page.tsx` and
 * `ChatView.tsx` are 1,600 lines that care about *what* a conversation store
 * does and not where it keeps things. Everything below the surface is new.
 *
 * Three behaviours matter beyond CRUD:
 *
 *  1. `saveTurn` sends only what changed. `contentKey` is carried over intact
 *     from the local-first build: it runs over the whole thread on every
 *     snapshot, and a long answer would otherwise rewrite every message in
 *     the thread every few seconds.
 *
 *  2. Truncation is explicit. Editing or regenerating drops a tail of the
 *     thread, and the server is told to delete from that seq rather than
 *     being left to infer it. The old build synthesised tombstones for this;
 *     with one authoritative store a delete is just a delete.
 *
 *  3. The list is updated optimistically. A save patches the in-memory array
 *     before the request settles, so the sidebar moves at the speed of the
 *     keyboard rather than the speed of the network.
 */

/**
 * How long a streaming thread waits between checkpoints.
 *
 * This number now carries the durability the 1.2s Dexie snapshot used to:
 * with no local store, whatever has not reached the server is what a closed
 * tab loses. The first checkpoint of a turn is therefore written immediately
 * — `lastDraftRef` is reset by every settled save — and only the ones after
 * it are throttled. So closing the tab early costs about a second of an
 * answer, closing it late costs at most this, and a long answer still writes
 * roughly a dozen times instead of fifty.
 */
const DRAFT_SYNC_MS = 5000;

/** Matches the Worker's own per-request limit; a larger batch is rejected. */
const MAX_MESSAGES_PER_WRITE = 50;

/**
 * Cheap identity of a message, used to decide whether a row is worth
 * rewriting. Covers everything that actually moves in this app: text growing
 * during a stream, a part appearing, the flight recorder being attached at
 * finish, and a message changing position after an edit.
 *
 * Deliberately not a deep compare of the whole row. It runs over the entire
 * thread on every snapshot, and it must not read the fields the store writes
 * back behind React's back — `blobId` and friends live inside `parts`, so
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
    // reading into them would pick up the blob ids the store adds, which is
    // exactly what must not count as a change.
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

/** What was last written for one thread, so the next save can diff it. */
type Written = Map<string, { key: string; seq: number }>;

export type ConversationsOptions = {
  /** Signed in, unlocked, and safe to talk to the server. */
  enabled: boolean;
  /** The thread this account had open last, from the synced settings blob. */
  restoreId?: string | null;
  /** Report the open thread upward so it can be persisted with the account. */
  onActiveChange?: (id: string | null) => void;
};

export function useConversations({
  enabled,
  restoreId = null,
  onActiveChange,
}: ConversationsOptions) {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  /**
   * True once the first list has landed. Only ever set forward — the
   * signed-out case is derived below rather than written from an effect,
   * which the React 19 lint correctly rejects as a cascading render.
   */
  const [loaded, setLoaded] = useState(false);
  const ready = enabled && loaded;
  /**
   * Bumped by local mutations only — never by `reload`.
   *
   * The account watches this for its status readout. Watching the
   * conversation array instead would feed back on itself: a refresh replaces
   * the array, which would read as a fresh local change forever.
   */
  const [localWrites, setLocalWrites] = useState(0);
  const touch = useCallback(() => setLocalWrites((n) => n + 1), []);

  /** Threads already sent for naming this session — one request each. */
  const namingRef = useRef(new Set<string>());
  /** When each open thread last checkpointed. See DRAFT_SYNC_MS. */
  const lastDraftRef = useRef(new Map<string, number>());
  /**
   * One writer per thread.
   *
   * Sealing a large answer (and spilling it to R2) is asynchronous. A final
   * save used to race the preceding half-answer checkpoint, so whichever
   * request happened to reach D1 last won — including the older checkpoint.
   * Chaining writes per thread makes request order equal transcript order.
   */
  const saveQueuesRef = useRef(new Map<string, Promise<void>>());
  /** Threads deleted locally; queued checkpoints for them become no-ops. */
  const removedRef = useRef(new Set<string>());
  /** Per-thread record of what has been written, keyed by message id. */
  const writtenRef = useRef(new Map<string, Written>());
  /** Threads the server is known to hold, so a first write creates the row. */
  const createdRef = useRef(new Set<string>());
  /** Mirrors `conversations` for the synchronous lookups `getMeta` does. */
  const byId = useMemo(
    () => new Map(conversations.map((row) => [row.id, row])),
    [conversations],
  );
  const byIdRef = useRef(byId);
  useEffect(() => {
    byIdRef.current = byId;
  }, [byId]);

  const onActiveChangeRef = useRef(onActiveChange);
  useEffect(() => {
    onActiveChangeRef.current = onActiveChange;
  }, [onActiveChange]);

  /** Pinned first, then most-recent — the server's own ordering. */
  const sort = useCallback((rows: ConversationMeta[]) => {
    return [...rows].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, []);

  const reload = useCallback(async () => {
    if (!enabled) return [];
    const rows = await listThreads();
    for (const row of rows) {
      createdRef.current.add(row.id);
      removedRef.current.delete(row.id);
    }
    const sorted = sort(rows);
    setConversations(sorted);
    return sorted;
  }, [enabled, sort]);

  /** Patch one thread into the list without a round trip. */
  const upsertLocal = useCallback(
    (meta: ConversationMeta) => {
      setConversations((rows) => {
        const next = rows.filter((row) => row.id !== meta.id);
        next.push(meta);
        return sort(next);
      });
    },
    [sort],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      let rows: ConversationMeta[] = [];
      try {
        rows = await listThreads();
      } catch {
        // A failed first list leaves an empty rail rather than a broken app;
        // the realtime socket or the next mutation will refresh it.
      }
      if (cancelled) return;
      for (const row of rows) {
        createdRef.current.add(row.id);
        removedRef.current.delete(row.id);
      }
      setConversations(sort(rows));
      setActiveIdState(rows.some((r) => r.id === restoreId) ? restoreId : null);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restoreId is a one-time seed, not a subscription
  }, [enabled, sort]);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    onActiveChangeRef.current?.(id);
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

      // Only if the thread still exists and hasn't been renamed by hand.
      const current = byIdRef.current.get(id);
      if (!current || current.titleGenerated) return;
      const next = { ...current, title, titleGenerated: true };
      upsertLocal(next);
      // The Dexie build wrote this title without marking the row dirty, so a
      // model-named thread never synced its own name until something else
      // touched it. There is nowhere else for the write to go now.
      await writeThread({ id, meta: next, touch: true });
    },
    [upsertLocal],
  );

  /**
   * Write the whole thread. `messages` is the authoritative state — anything
   * the server holds beyond it is truncated away.
   */
  const performSave = useCallback(
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
      /** A mid-stream checkpoint: written on a slower clock. */
      draft?: boolean;
    }) => {
      if (!enabled || removedRef.current.has(id) || messages.length === 0) return;

      /*
       * A checkpoint is skipped rather than queued.
       *
       * The first one after any settled save goes immediately — that is what
       * bounds how much of an answer a closed tab can lose — and the rest are
       * throttled. Skipping is safe because the next checkpoint carries the
       * whole message, not a delta.
       */
      const now = Date.now();
      if (draft) {
        const lastDraft = lastDraftRef.current.get(id) ?? 0;
        if (now - lastDraft < DRAFT_SYNC_MS) return;
        lastDraftRef.current.set(id, now);
      } else {
        lastDraftRef.current.delete(id);
      }

      const existing = byIdRef.current.get(id);
      const { totalCostUsd, totalTokens } = totalsOf(messages);

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
      };

      const written = writtenRef.current.get(id) ?? (new Map() as Written);
      const keep = new Set(messages.map((m) => m.id));

      /*
       * Anything previously written and now absent means the thread was cut
       * short — an edit, a regenerate, or a branch. The lowest missing seq is
       * where the server has to truncate, and everything from there on has to
       * be rewritten regardless of whether its content changed, because the
       * truncate deletes it first.
       */
      let truncateFrom: number | undefined;
      for (const [messageId, prior] of written) {
        if (keep.has(messageId)) continue;
        truncateFrom =
          truncateFrom === undefined ? prior.seq : Math.min(truncateFrom, prior.seq);
      }

      const changed: StoredMessage[] = [];
      const nextWritten: Written = new Map();
      messages.forEach((m, seq) => {
        const key = contentKey(m, seq);
        nextWritten.set(m.id, { key, seq });
        const prior = written.get(m.id);
        const rewritten =
          truncateFrom !== undefined && seq >= truncateFrom;
        if (!rewritten && prior && prior.key === key) return;
        changed.push({ ...m, conversationId: id, seq });
      });

      // The thread row is written when its own metadata moved, and always on
      // the first write of a thread the server has never seen — a message
      // sent into a thread that does not exist is dropped on purpose.
      const fresh = !createdRef.current.has(id);
      const metaMoved =
        fresh ||
        !draft ||
        !existing ||
        existing.totalCostUsd !== totalCostUsd ||
        existing.model !== settings.model;

      if (changed.length === 0 && !metaMoved && truncateFrom === undefined) {
        return;
      }

      upsertLocal(meta);

      // Chunked so one write can never exceed the server's per-request cap.
      // Only the first chunk carries the metadata and the truncation.
      const chunks: StoredMessage[][] = [];
      for (let i = 0; i < changed.length; i += MAX_MESSAGES_PER_WRITE) {
        chunks.push(changed.slice(i, i + MAX_MESSAGES_PER_WRITE));
      }
      if (chunks.length === 0) chunks.push([]);

      try {
        for (const [index, chunk] of chunks.entries()) {
          await writeThread({
            id,
            meta: index === 0 && metaMoved ? meta : undefined,
            truncateFrom: index === 0 ? truncateFrom : undefined,
            messages: chunk,
            touch: !draft,
          });
        }
      } catch (error) {
        // Leave `written` untouched so the next checkpoint retries the same
        // messages. Losing the record of what landed would be worse than
        // resending: the retry is idempotent, a gap is not.
        lastDraftRef.current.delete(id);
        throw error;
      }

      createdRef.current.add(id);
      writtenRef.current.set(id, nextWritten);
      touch();

      if (naming && !meta.titleGenerated && messages.length >= 2) {
        void nameThread(id, messages);
      }
    },
    [enabled, nameThread, touch, upsertLocal],
  );

  const saveTurn = useCallback(
    (input: Parameters<typeof performSave>[0]): Promise<void> => {
      const previous = saveQueuesRef.current.get(input.id) ?? Promise.resolve();
      const queued = previous
        // A failed checkpoint must not poison the queue. The caller that made
        // it still receives the rejection; the next (fuller) snapshot gets a
        // chance to repair the cloud copy.
        .catch(() => undefined)
        .then(() => performSave(input));

      saveQueuesRef.current.set(input.id, queued);
      return queued.finally(() => {
        if (saveQueuesRef.current.get(input.id) === queued) {
          saveQueuesRef.current.delete(input.id);
        }
      });
    },
    [performSave],
  );

  const loadMessages = useCallback(
    async (conversationId: string): Promise<DialMessage[]> => {
      if (!enabled) return [];
      const opened = await readThread(conversationId);
      if (!opened) {
        writtenRef.current.delete(conversationId);
        return [];
      }

      createdRef.current.add(conversationId);
      removedRef.current.delete(conversationId);
      upsertLocal(opened.meta);

      // Seed the diff map from what the server actually holds, so the next
      // save rewrites only what the user changes from here.
      const written: Written = new Map();
      opened.messages.forEach((row, seq) => {
        written.set(row.id, { key: contentKey(row, seq), seq });
      });
      writtenRef.current.set(conversationId, written);

      // Strip the storage-only columns before handing rows to useChat.
      return opened.messages.map((row) => {
        const message = { ...row } as Partial<StoredMessage>;
        delete message.conversationId;
        delete message.seq;
        return message as DialMessage;
      });
    },
    [enabled, upsertLocal],
  );

  /** Persist a metadata change on a thread the list already knows about. */
  const patchMeta = useCallback(
    async (id: string, patch: Partial<ConversationMeta>) => {
      const current = byIdRef.current.get(id);
      if (!current) return;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      upsertLocal(next);
      touch();
      await writeThread({ id, meta: next, touch: true });
    },
    [touch, upsertLocal],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      // A hand-typed name is final — stop the generator from replacing it.
      await patchMeta(id, { title, titleGenerated: true });
    },
    [patchMeta],
  );

  const remove = useCallback(
    async (id: string) => {
      removedRef.current.add(id);
      setConversations((rows) => rows.filter((row) => row.id !== id));
      writtenRef.current.delete(id);
      createdRef.current.delete(id);
      lastDraftRef.current.delete(id);
      touch();
      setActiveIdState((current) => {
        if (current !== id) return current;
        onActiveChangeRef.current?.(null);
        return null;
      });
      // Let a request already inside fetch settle, then delete after it. Any
      // checkpoint queued from this point sees `removedRef` and becomes a
      // no-op, so a late final save cannot resurrect the thread.
      await saveQueuesRef.current.get(id)?.catch(() => undefined);
      await deleteThread(id);
    },
    [touch],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const row = byIdRef.current.get(id);
      if (!row) return;
      await patchMeta(id, { pinned: !row.pinned });
    },
    [patchMeta],
  );

  const updateSettings = useCallback(
    async (id: string, patch: Partial<ChatSettings>) => {
      await patchMeta(id, patch);
    },
    [patchMeta],
  );

  const getMeta = useCallback(
    async (id: string) => byIdRef.current.get(id),
    [],
  );

  /**
   * Apply a realtime delta.
   *
   * Thread rows arrive whole, so they replace what the list holds rather than
   * being merged into it. A thread this device deleted a moment ago can come
   * back in a delta it had already been told about; `removed` is applied
   * after the upserts for exactly that reason.
   */
  const applyDelta = useCallback(
    (threads: ConversationMeta[], removed: string[]) => {
      if (threads.length === 0 && removed.length === 0) return;
      setConversations((rows) => {
        const merged = new Map(rows.map((row) => [row.id, row]));
        for (const row of threads) merged.set(row.id, row);
        for (const id of removed) merged.delete(id);
        return sort([...merged.values()]);
      });
      for (const row of threads) createdRef.current.add(row.id);
      for (const id of removed) {
        writtenRef.current.delete(id);
        createdRef.current.delete(id);
      }
    },
    [sort],
  );

  return {
    conversations,
    activeId,
    setActiveId,
    ready,
    /** Increments on local mutations; the account's change signal. */
    localWrites,
    /** Re-read the list from the server. */
    reload,
    saveTurn,
    loadMessages,
    rename,
    remove,
    togglePin,
    updateSettings,
    getMeta,
    /** Fold a realtime delta into the list without a round trip. */
    applyDelta,
  };
}

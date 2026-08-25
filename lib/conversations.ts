"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Dexie from "dexie";
import type { UIMessage } from "ai";
import {
  db,
  deriveTitle,
  textOf,
  totalsOf,
  type ConversationMeta,
  type StoredMessage,
} from "./db";
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
 *     so the sidebar is never blank, then /api/title replaces it once. The
 *     network call is fire-and-forget: it can never block or fail a save.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** Threads already sent for naming this session — one request each. */
  const namingRef = useRef(new Set<string>());

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
  const generateTitle = useCallback(
    async (id: string, messages: DialMessage[]) => {
      if (namingRef.current.has(id)) return;
      const prompt = messages.find((m) => m.role === "user");
      const reply = messages.find((m) => m.role === "assistant");
      if (!prompt) return;
      const promptText = textOf(prompt);
      if (!promptText) return;
      namingRef.current.add(id);

      try {
        const res = await fetch("/api/title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: promptText.slice(0, 2000),
            reply: reply ? textOf(reply).slice(0, 2000) : undefined,
          }),
        });
        if (!res.ok) return;
        const { title } = (await res.json()) as { title?: string };
        if (!title) return;
        // Only if the row still exists and hasn't been renamed by hand.
        const current = await db.conversations.get(id);
        if (!current || current.titleGenerated) return;
        await db.conversations.update(id, { title, titleGenerated: true });
        await reload();
      } catch {
        // Keep the fallback title — naming is a nicety, not a requirement.
      }
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
    }: {
      id: string;
      settings: ChatSettings;
      messages: DialMessage[];
      /** False while streaming — don't name a half-finished thread. */
      naming?: boolean;
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
      };

      const rows: StoredMessage[] = messages.map((m, seq) => ({
        ...m,
        conversationId: id,
        seq,
      }));
      const keep = new Set(rows.map((r) => r.id));

      await db.transaction("rw", db.conversations, db.messages, async () => {
        await db.conversations.put(meta);
        const stale = await db.messages
          .where("conversationId")
          .equals(id)
          .primaryKeys();
        const drop = stale.filter((key) => !keep.has(key));
        if (drop.length > 0) await db.messages.bulkDelete(drop);
        await db.messages.bulkPut(rows);
      });

      await reload();

      if (naming && !meta.titleGenerated && messages.length >= 2) {
        void generateTitle(id, messages);
      }
    },
    [reload, generateTitle],
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
      await db.conversations.update(id, { title, titleGenerated: true });
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await db.transaction("rw", db.conversations, db.messages, async () => {
        await db.conversations.delete(id);
        await db.messages.where("conversationId").equals(id).delete();
      });
      await reload();
      setActiveIdState((current) => {
        if (current !== id) return current;
        localStorage.removeItem("dial:active");
        return null;
      });
    },
    [reload],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const row = await db.conversations.get(id);
      if (!row) return;
      await db.conversations.update(id, { pinned: !row.pinned });
      await reload();
    },
    [reload],
  );

  /** Persist a settings change on a thread that may not exist yet. */
  const updateSettings = useCallback(
    async (id: string, patch: Partial<ChatSettings>) => {
      const row = await db.conversations.get(id);
      if (!row) return;
      await db.conversations.update(id, { ...patch, updatedAt: Date.now() });
      await reload();
    },
    [reload],
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
    saveTurn,
    loadMessages,
    rename,
    remove,
    togglePin,
    updateSettings,
    getMeta,
  };
}

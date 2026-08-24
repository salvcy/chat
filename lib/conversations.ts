"use client";

import {
  db,
  deriveTitle,
  type ConversationMeta,
} from "./db";
import { useCallback, useEffect, useState } from "react";
import type { ChatOnFinishCallback, UIMessage } from "ai";
import type { ReasoningEffort } from "./types";

/**
 * Thin persistence helper layered on useChat. Keeps conversations +
 * their messages in Dexie; settings (model/reasoning/search) persist
 * per-conversation; last active id persisted in localStorage.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const rows = await db.conversations
      .orderBy("updatedAt")
      .reverse()
      .toArray();
    setConversations(rows);
    return rows;
  }, []);

  // Hydrate list + last-active on mount (client-only).
  useEffect(() => {
    let cancelled = false;
    db.conversations
      .orderBy("updatedAt")
      .reverse()
      .toArray()
      .then((rows) => {
        if (cancelled) return;
        const saved =
          typeof window !== "undefined"
            ? localStorage.getItem("dial:active")
            : null;
        const first = rows[0]?.id ?? null;
        const active = rows.some((r) => r.id === saved) ? saved : first;
        setConversations(rows);
        setActiveIdState(active);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem("dial:active", id);
  }, []);

  const ensureConversation = useCallback(
    async (meta: Omit<ConversationMeta, "createdAt" | "updatedAt">) => {
      await db.conversations.put({
        ...meta,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return meta.id;
    },
    [],
  );

  const persist = useCallback(
    ({
      id,
      model,
      reasoning,
      search,
      messages,
    }: {
      id: string;
      model: string;
      reasoning: ReasoningEffort;
      search: boolean;
      messages: UIMessage[];
    }) => {
      const title = deriveTitle(messages);
      db.conversations.put({
        id,
        title,
        model,
        reasoning,
        search,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      void db.messages
        .bulkPut(messages.map((m) => ({ ...m, conversationId: id })));
      void reload();
    },
    [reload],
  );

  const loadMessages = useCallback(
    async (conversationId: string): Promise<UIMessage[]> => {
      const rows = await db.messages
        .where("conversationId")
        .equals(conversationId)
        .toArray();
      return rows.map(({ conversationId: _dropped, ...m }) => {
        void _dropped;
        return m as UIMessage;
      });
    },
    [],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      await db.conversations.update(id, { title });
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await db.conversations.delete(id);
      await db.messages.where("conversationId").equals(id).delete();
      await reload();
      if (activeId === id) setActiveId(null);
    },
    [reload, activeId, setActiveId],
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
    ensureConversation,
    persist,
    loadMessages,
    rename,
    remove,
    getMeta,
  };
}

/** Callback shape the page passes to useChat: persist on stream finish. */
export function makeOnFinish(
  opts: {
    conversationId: string | null;
    model: string;
    reasoning: ReasoningEffort;
    search: boolean;
  },
  persist: (o: {
    id: string;
    model: string;
    reasoning: ReasoningEffort;
    search: boolean;
    messages: UIMessage[];
  }) => void,
  setActiveId: (id: string) => void,
): ChatOnFinishCallback<UIMessage> {
  return ({ messages, isError }) => {
    if (isError) return;
    const id = opts.conversationId ?? crypto.randomUUID();
    setActiveId(id);
    persist({ id, model: opts.model, reasoning: opts.reasoning, search: opts.search, messages });
  };
}

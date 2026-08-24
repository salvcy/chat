"use client";

import { useEffect, useState } from "react";
import ConversationList from "@/components/sidebar/ConversationList";
import ThemeToggle from "@/components/tuner/ThemeToggle";
import ModelSwitcher from "@/components/tuner/ModelSwitcher";
import { useConversations } from "@/lib/conversations";
import { DEFAULT_MODEL, type OpenRouterModel } from "@/lib/types";
import ChatView from "@/components/chat/ChatView";

/**
 * Shell: owns the conversation list, the live model catalog, the active
 * conversation's settings/messages, and the selected model. The chat renders
 * in a keyed ChatView — remounting per conversation guarantees useChat's
 * session and its in-memory messages reset, so histories never interleave
 * (the "user chat appears after streamed text" bug) and there's no flash of
 * the previous conversation.
 */
export default function Home() {
  const conv = useConversations();
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [initial, setInitial] = useState<{
    key: string;
    reasoning: import("@/lib/types").ReasoningEffort;
    search: boolean;
    messages: import("ai").UIMessage[];
  } | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Live catalog (cached server-side).
  useEffect(() => {
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { models: OpenRouterModel[] }) => setModels(d.models))
      .catch(() => setModels([]));
  }, []);

  // ⌘K opens the model switcher.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Resolve the active conversation's settings + messages, THEN render the
  // keyed ChatView once (no loading flash, no cross-conversation bleed).
  useEffect(() => {
    if (!conv.ready) return;
    const id = conv.activeId;
    let cancelled = false;
    if (!id) {
      queueMicrotask(() => {
        if (cancelled) return;
        setModel(DEFAULT_MODEL);
        setInitial({ key: "new", reasoning: "off", search: false, messages: [] });
        setLoadedKey("new");
      });
      return;
    }
    Promise.all([conv.getMeta(id), conv.loadMessages(id)]).then(([meta, msgs]) => {
      if (cancelled) return;
      setModel(meta?.model ?? DEFAULT_MODEL);
      setInitial({
        key: id,
        reasoning: meta?.reasoning ?? "off",
        search: meta?.search ?? false,
        messages: msgs,
      });
      setLoadedKey(id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-resolve when the active conversation changes
  }, [conv.ready, conv.activeId]);

  const selectConversation = (id: string) => {
    conv.setActiveId(id);
    setSidebarOpen(false);
  };

  const newConversation = () => {
    conv.setActiveId(null);
    setSidebarOpen(false);
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Desktop sidebar — fixed rail, does not scroll with chat */}
      <div className="hidden h-full w-72 shrink-0 md:block">
        <ConversationList
          conversations={conv.conversations}
          activeId={conv.activeId}
          onSelect={selectConversation}
          onNew={newConversation}
          onRename={(id, t) => void conv.rename(id, t)}
          onDelete={(id) => void conv.remove(id)}
        />
      </div>

      {/* Mobile sidebar drawer */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-50 bg-background/50 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        >
          <div
            className="h-full w-72 max-w-[82vw] bg-background/80 backdrop-blur-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            <ConversationList
              conversations={conv.conversations}
              activeId={conv.activeId}
              onSelect={selectConversation}
              onNew={newConversation}
              onRename={(id, t) => void conv.rename(id, t)}
              onDelete={(id) => void conv.remove(id)}
            />
          </div>
        </div>
      )}

      <main className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-end gap-1 px-4 pt-3">
          <div className="md:hidden">
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Conversations"
              className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
              </svg>
            </button>
          </div>
          <ThemeToggle />
        </div>

        {initial && loadedKey === (conv.activeId ?? "new") ? (
          <ChatView
            key={initial.key}
            conversationKey={initial.key}
            conversationId={conv.activeId}
            model={model}
            initialReasoning={initial.reasoning}
            initialSearch={initial.search}
            initialMessages={initial.messages}
            models={models}
            onOpenSwitcher={() => setSwitcherOpen(true)}
            persist={conv.persist}
            setActiveId={conv.setActiveId}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <span className="font-mono text-xs text-muted">…</span>
          </div>
        )}

        {switcherOpen && (
          <ModelSwitcher
            models={models}
            current={model}
            onSelect={(id) => {
              setModel(id);
              setSwitcherOpen(false);
            }}
            onClose={() => setSwitcherOpen(false)}
          />
        )}
      </main>
    </div>
  );
}

"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import Composer from "./Composer";
import MessageBubble from "./MessageBubble";
import { makeOnFinish } from "@/lib/conversations";
import type { OpenRouterModel, ReasoningEffort } from "@/lib/types";

/**
 * The live chat. Remounted per conversation (keyed by the parent) so its
 * useChat session is always a single conversation — messages never leak
 * across threads. Transcript is the only scrolling region and auto-sticks
 * to the bottom while streaming unless the user scrolls up to read.
 */
export default function ChatView({
  conversationKey,
  conversationId,
  model,
  initialReasoning,
  initialSearch,
  initialMessages,
  models,
  onOpenSwitcher,
  persist,
  setActiveId,
}: {
  conversationKey: string;
  conversationId: string | null;
  model: string;
  initialReasoning: ReasoningEffort;
  initialSearch: boolean;
  initialMessages: UIMessage[];
  models: OpenRouterModel[];
  onOpenSwitcher: () => void;
  persist: (o: {
    id: string;
    model: string;
    reasoning: ReasoningEffort;
    search: boolean;
    messages: UIMessage[];
  }) => void;
  setActiveId: (id: string) => void;
}) {
  const [reasoning, setReasoning] = useState<ReasoningEffort>(initialReasoning);
  const [search, setSearch] = useState(initialSearch);
  const [input, setInput] = useState("");
  // Mint the conversation id once per mount so remounts (driven by
  // setActiveId after the first exchange) never produce a duplicate.
  const [idRef] = useState(() => conversationId ?? crypto.randomUUID());

  const onFinish = useMemo(
    () =>
      makeOnFinish(
        { conversationId: idRef, model, reasoning, search },
        persist,
        setActiveId,
      ),
    [idRef, model, reasoning, search, persist, setActiveId],
  );

  const { messages, sendMessage, status, error } = useChat({
    id: conversationKey,
    messages: initialMessages,
    onFinish,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const busy = status === "streaming" || status === "submitted";

  // Auto-scroll: stick to bottom on stream unless user scrolled up (>80px).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    stickRef.current = true;
    sendMessage({ text }, { body: { model, reasoning, search } });
    setInput("");
  };

  return (
    <>
      {/* scrollable transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="dial-scroll flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[680px] px-5 pb-4 pt-2">
          {messages.length === 0 && (
            <div className="flex min-h-[60vh] flex-col items-center justify-center">
              <p className="font-mono text-3xl tracking-tight text-foreground">
                dial
              </p>
              <p className="mt-3 font-mono text-xs text-muted">{model}</p>
              <p className="mt-8 text-center text-sm leading-relaxed text-muted">
                one key, every model.
                <br />
                ⌘K to tune · ⏎ to send
              </p>
            </div>
          )}
          <div className="space-y-6">
            {messages.map((m, idx) => (
              <MessageBubble
                key={m.id}
                message={m}
                streaming={
                  busy && idx === messages.length - 1 && m.role === "assistant"
                }
              />
            ))}
          </div>
          {error && (
            <div className="mt-4 rounded-xl border border-hairline bg-surface px-4 py-3 backdrop-blur-[20px]">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
                upstream error
              </p>
              <p className="mt-1 font-mono text-xs leading-relaxed text-foreground">
                {error.message}
              </p>
              <p className="mt-2 font-mono text-[10px] text-muted">
                {/guardrail|data policy|privacy/i.test(error.message)
                  ? "this model is restricted by your OpenRouter data policy — pick another model (⌘K)"
                  : "the request failed — try again or switch model (⌘K)"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* composer */}
      <div className="mx-auto w-full max-w-[680px]">
        <Composer
          input={input}
          setInput={setInput}
          onSend={send}
          busy={busy}
          reasoning={reasoning}
          setReasoning={setReasoning}
          search={search}
          setSearch={setSearch}
          model={model}
          models={models}
          onOpenSwitcher={onOpenSwitcher}
        />
      </div>
    </>
  );
}

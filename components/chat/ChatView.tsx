"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  convertFileListToFileUIParts,
  type FileUIPart,
} from "ai";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Composer from "./Composer";
import EmptyState from "./EmptyState";
import MessageBubble from "./MessageBubble";
import MessageNavigator from "./MessageNavigator";
import SystemPrompt from "./SystemPrompt";
import type { DialMessage } from "@/lib/conversations";
import { capabilitiesFor } from "@/lib/capabilities";
import { hasRenderableResponse } from "@/lib/messages";
import {
  DEFAULT_IMAGE_MODEL,
  type ChatSettings,
  type GeneratedImageData,
  type OpenRouterModel,
  type RequestStatusData,
} from "@/lib/types";

/** How often a mid-stream snapshot is written to IndexedDB. */
const STREAM_SAVE_MS = 1200;
/** Distance from the bottom that still counts as "following the stream". */
const STICK_THRESHOLD_PX = 80;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;

type ImageRouteResponse = {
  model: string;
  images: Array<{ url: string; mediaType: string }>;
  durationMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};

/** Approximate decoded bytes in the data URLs held by FileUIParts. */
function attachmentBytes(part: FileUIPart): number {
  const comma = part.url.indexOf(",");
  if (comma < 0 || !part.url.slice(0, comma).includes(";base64")) return 0;
  return Math.floor(((part.url.length - comma - 1) * 3) / 4);
}

function isImageReference(part: DialMessage["parts"][number]): boolean {
  if (part.type !== "file") return false;
  const dial = part.providerMetadata?.dial;
  return !!dial && typeof dial === "object" && dial.imageReference === true;
}

/**
 * Keep generated pixels local. The text model gets a compact provenance note,
 * never a multi-megabyte base64 payload or image-only reference attachment.
 */
function messagesForTextModel(messages: DialMessage[]): DialMessage[] {
  return messages.flatMap((message) => {
    const parts = message.parts.flatMap((part) => {
      if (isImageReference(part)) return [];
      if (part.type === "data-requestStatus") return [];
      if (part.type !== "data-image") return [part];
      const outcome =
        part.data.status === "complete" ? "Generated image" : "Image request";
      return [
        {
          type: "text" as const,
          text: `[${outcome}: ${part.data.prompt}]`,
        },
      ];
    });
    // A placeholder-only assistant turn has no model-visible content. Drop
    // that turn from the next request instead of sending an invalid empty
    // assistant message; partial responses keep their real text/reasoning.
    if (message.role === "assistant" && parts.length === 0) return [];
    return [{ ...message, parts }];
  });
}

/** Attach a quiet, persisted terminal state to an interrupted/empty turn. */
function withRequestStatus(
  messages: DialMessage[],
  assistant: DialMessage,
  kind: RequestStatusData["kind"],
): DialMessage[] {
  const statusPart = {
    type: "data-requestStatus" as const,
    id: `${assistant.id}-request-status`,
    data: { kind, at: Date.now() },
  };
  const withStatus: DialMessage = {
    ...assistant,
    metadata: {
      ...assistant.metadata,
      finishReason:
        kind === "interrupted"
          ? "abort"
          : (assistant.metadata?.finishReason ?? "empty"),
    },
    parts: [
      ...assistant.parts.filter((part) => part.type !== "data-requestStatus"),
      statusPart,
    ],
  };
  const index = messages.findIndex((message) => message.id === assistant.id);
  if (index < 0) return [...messages, withStatus];
  return messages.map((message, messageIndex) =>
    messageIndex === index ? withStatus : message,
  );
}

/**
 * The live chat.
 *
 * Remounted per conversation by the shell, so its useChat session is always
 * exactly one thread. Three behaviours worth knowing:
 *
 *  - The transcript is the only scrolling region, and follows the stream
 *    until you scroll up; a jump-to-bottom control appears when it stops.
 *  - Messages are snapshotted mid-stream, so closing the tab on a long
 *    answer no longer throws it away.
 *  - Edit and regenerate truncate the thread rather than appending; the
 *    store reconciles deletions, so no orphan branches survive a reload.
 */
export default function ChatView({
  conversationId,
  settings,
  onSettingsChange,
  initialMessages,
  models,
  onOpenSwitcher,
  onBranch,
  saveTurn,
  setActiveId,
}: {
  conversationId: string;
  settings: ChatSettings;
  onSettingsChange: (patch: Partial<ChatSettings>) => void;
  initialMessages: DialMessage[];
  models: OpenRouterModel[];
  onOpenSwitcher: () => void;
  onBranch: (messages: DialMessage[], settings: ChatSettings) => void;
  saveTurn: (o: {
    id: string;
    settings: ChatSettings;
    messages: DialMessage[];
    naming?: boolean;
  }) => Promise<void>;
  setActiveId: (id: string) => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<FileUIPart[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [systemOpen, setSystemOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [imageMode, setImageMode] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const imageAbortRef = useRef<AbortController | null>(null);
  const setChatMessagesRef = useRef<((messages: DialMessage[]) => void) | null>(
    null,
  );

  // The shell mints the id, including for unsaved threads, so this stays
  // stable across the moment the conversation first becomes "active".
  const threadId = conversationId;

  // Read settings through a ref inside callbacks — otherwise onFinish, which
  // useChat captures once, would persist against a stale copy after a
  // mid-thread model switch. Synced after commit, never during render.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });

  const transport = useMemo(
    () =>
      new DefaultChatTransport<DialMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...body,
            messages: messagesForTextModel(messages),
          },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } =
    useChat<DialMessage>({
      id: threadId,
      messages: initialMessages,
      transport,
      onFinish: ({ message, messages: finished, isAbort }) => {
        const requestStatus = isAbort
          ? "interrupted"
          : hasRenderableResponse(message)
            ? null
            : "empty";
        const settled = requestStatus
          ? withRequestStatus(finished, message, requestStatus)
          : finished;

        if (settled !== finished) {
          setChatMessagesRef.current?.(settled);
        }
        // Write BEFORE announcing the thread. Flipping activeId first made
        // the shell read this conversation out of Dexie while the save was
        // still in flight, get nothing back, and blank the transcript — the
        // first exchange of a new thread vanished a beat after it arrived.
        void saveTurn({
          id: threadId,
          settings: settingsRef.current,
          messages: settled,
        }).then(() => setActiveId(threadId));
      },
    });

  useEffect(() => {
    setChatMessagesRef.current = setMessages;
  }, [setMessages]);

  const chatBusy = status === "streaming" || status === "submitted";
  const busy = chatBusy || imageBusy;
  const selectedCapabilities = capabilitiesFor(settings.model, models);
  const canSeeImages = selectedCapabilities.vision;
  const selectedImageModel = selectedCapabilities.imageGeneration
    ? settings.model
    : undefined;
  const activeImageModel = selectedImageModel ?? DEFAULT_IMAGE_MODEL;

  /** The body sent with every turn — the whole per-conversation state. */
  const requestBody = useCallback(() => {
    const s = settingsRef.current;
    return {
      model: s.model,
      reasoning: s.reasoning,
      search: s.search,
      ...(s.system.trim() ? { system: s.system } : {}),
    };
  }, []);

  /* ----------------------- mid-stream persistence ---------------------- */

  // Latest messages, read by the snapshot timer. Keeping them in a ref is
  // what lets the timer depend only on `busy`: an effect that depended on
  // `messages` was torn down and rebuilt on every token, so its cleanup
  // cleared the pending timeout each time and the snapshot never fired.
  const latestRef = useRef(messages);
  useEffect(() => {
    latestRef.current = messages;
  });

  useEffect(() => {
    if (!chatBusy) return;
    const timer = setInterval(() => {
      const snapshot = latestRef.current;
      if (snapshot.length === 0) return;
      // naming:false — a half-written thread isn't worth naming yet.
      void saveTurn({
        id: threadId,
        settings: settingsRef.current,
        messages: snapshot,
        naming: false,
      });
    }, STREAM_SAVE_MS);
    return () => clearInterval(timer);
  }, [chatBusy, saveTurn, threadId]);

  /* ------------------------------ scroll ------------------------------- */

  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const scrollGeometryRef = useRef<{
    top: number;
    clientHeight: number;
  } | null>(null);

  /**
   * Pin after the DOM has its final measured height. The last streaming
   * render adds metrics/actions and can settle over more than one layout
   * pass, so a single effect-time `scrollTop` write is not sufficient.
   */
  const followLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    scrollGeometryRef.current = {
      top: el.scrollTop,
      clientHeight: el.clientHeight,
    };
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const previous = scrollGeometryRef.current;
    const current = {
      top: el.scrollTop,
      clientHeight: el.clientHeight,
    };
    scrollGeometryRef.current = current;

    // Growing the composer emits a scroll event even though the reader did
    // not scroll: scrollTop stays put while the viewport gets shorter. Do not
    // interpret that browser-generated event as an instruction to stop
    // following the answer. The ResizeObserver below will restore the bottom.
    if (
      previous &&
      Math.abs(previous.top - current.top) < 1 &&
      previous.clientHeight !== current.clientHeight
    ) {
      // The textarea briefly collapses to measure itself, then expands back
      // in the same frame. ResizeObserver may coalesce those two sizes and
      // never fire, so restore the anchor directly from this final event.
      followLatest();
      return;
    }

    const near =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    stickRef.current = near;
    setAtBottom(near);
  };

  useLayoutEffect(() => {
    // An empty workspace has nothing to follow. Scrolling it to its own
    // bottom hid the top half of the welcome state on shorter viewports.
    if (messages.length === 0) return;
    followLatest();

    // The SDK's finished state and the message's final UI do not always land
    // in the same layout pass. Re-pin on the next frame before the browser's
    // own scroll anchoring gets a chance to choose an older message.
    const frame = requestAnimationFrame(followLatest);
    return () => cancelAnimationFrame(frame);
  }, [messages, status, followLatest]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const scroller = scrollRef.current;
    if (!transcript || !scroller || typeof ResizeObserver === "undefined") {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(followLatest);
    });
    // Follow both kinds of geometry change: streaming alters the transcript's
    // height, while a wrapping composer shrinks the scroller's viewport. The
    // latter used to leave scrollTop unchanged and make every newly wrapped
    // line look like an upward jump.
    observer.observe(transcript);
    observer.observe(scroller);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [followLatest]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  /* ------------------------------ actions ------------------------------ */

  const updateComposerInput = (value: string) => {
    if (!imageMode) {
      const invocation = value.match(/^@image(?:\s+|$)/i);
      if (invocation) {
        setImageMode(true);
        setAttachmentError(null);
        setInput(value.slice(invocation[0].length));
        return;
      }
    }
    setInput(value);
  };

  const selectImageTool = () => {
    setImageMode(true);
    setAttachmentError(null);
    setInput((current) => (/^@\w*$/i.test(current) ? "" : current));
  };

  const runImage = useCallback(
    async (
      prompt: string,
      options?: {
        replaceMessageId?: string;
        references?: FileUIPart[];
      },
    ) => {
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt || busy) return;

      clearError();
      setAttachmentError(null);
      stickRef.current = true;

      const startedAt = Date.now();
      const assistantId = options?.replaceMessageId ?? crypto.randomUUID();
      const references = options?.references ?? attachments;
      const pendingData: GeneratedImageData = {
        status: "generating",
        prompt: cleanPrompt,
        model: activeImageModel,
        images: [],
        startedAt,
        durationMs: null,
        costUsd: null,
        error: null,
      };

      const pendingAssistant: DialMessage = {
        id: assistantId,
        role: "assistant",
        metadata: { model: activeImageModel, startedAt },
        parts: [{ type: "data-image", id: assistantId, data: pendingData }],
      };

      let pendingMessages: DialMessage[];
      if (options?.replaceMessageId) {
        pendingMessages = messages.map((message) =>
          message.id === options.replaceMessageId ? pendingAssistant : message,
        );
      } else {
        const taggedReferences = references.map((reference) => ({
          ...reference,
          providerMetadata: {
            ...reference.providerMetadata,
            dial: { imageReference: true },
          },
        }));
        const userMessage: DialMessage = {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            { type: "text", text: `@image ${cleanPrompt}` },
            ...taggedReferences,
          ],
        };
        pendingMessages = [...messages, userMessage, pendingAssistant];
      }

      latestRef.current = pendingMessages;
      setMessages(pendingMessages);
      setInput("");
      setAttachments([]);
      setImageBusy(true);

      const controller = new AbortController();
      imageAbortRef.current = controller;

      let finalData: GeneratedImageData;
      let finalMetadata: DialMessage["metadata"];
      try {
        const response = await fetch("/api/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(selectedImageModel ? { model: selectedImageModel } : {}),
            prompt: cleanPrompt,
            ...(references.length > 0
              ? {
                  references: references.map((reference) => ({
                    url: reference.url,
                    mediaType: reference.mediaType,
                  })),
                }
              : {}),
          }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as
          | ImageRouteResponse
          | { error?: string };
        if (!response.ok || !("images" in payload)) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Image generation failed.",
          );
        }

        finalData = {
          status: "complete",
          prompt: cleanPrompt,
          model: payload.model,
          images: payload.images,
          startedAt,
          durationMs: payload.durationMs,
          costUsd: payload.usage?.costUsd ?? null,
          error: null,
        };
        finalMetadata = {
          model: payload.model,
          startedAt,
          durationMs: payload.durationMs,
          costUsd: payload.usage?.costUsd,
          promptTokens: payload.usage?.promptTokens,
          completionTokens: payload.usage?.completionTokens,
          finishReason: "image",
        };
      } catch (requestError) {
        finalData = {
          ...pendingData,
          status: "error",
          durationMs: Date.now() - startedAt,
          error:
            controller.signal.aborted
              ? "Image generation stopped."
              : requestError instanceof Error
                ? requestError.message
                : "Image generation failed.",
        };
        finalMetadata = {
          model: activeImageModel,
          startedAt,
          durationMs: finalData.durationMs ?? undefined,
          finishReason: controller.signal.aborted ? "abort" : "error",
        };
      } finally {
        if (imageAbortRef.current === controller) imageAbortRef.current = null;
        setImageBusy(false);
        setImageMode(false);
      }

      const finalMessages = pendingMessages.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              metadata: finalMetadata,
              parts: [
                {
                  type: "data-image" as const,
                  id: assistantId,
                  data: finalData,
                },
              ],
            }
          : message,
      );
      latestRef.current = finalMessages;
      setMessages(finalMessages);
      await saveTurn({
        id: threadId,
        settings: settingsRef.current,
        messages: finalMessages,
      });
      setActiveId(threadId);
    },
    [
      attachments,
      activeImageModel,
      busy,
      clearError,
      messages,
      saveTurn,
      selectedImageModel,
      setActiveId,
      setMessages,
      threadId,
    ],
  );

  const stopAll = useCallback(() => {
    if (imageAbortRef.current) imageAbortRef.current.abort();
    else void stop();
  }, [stop]);

  const send = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    if (imageMode) {
      if (!text) {
        setAttachmentError("Describe the image you want to generate.");
        return;
      }
      void runImage(text);
      return;
    }
    if (attachments.length > 0 && !canSeeImages) {
      setAttachmentError("Choose a model with image input before sending.");
      return;
    }
    clearError();
    setAttachmentError(null);
    stickRef.current = true;
    if (text) {
      sendMessage(
        { text, ...(attachments.length ? { files: attachments } : {}) },
        { body: requestBody() },
      );
    } else {
      sendMessage({ files: attachments }, { body: requestBody() });
    }
    setInput("");
    setAttachments([]);
  };

  const addAttachments = async (files: FileList) => {
    setAttachmentError(null);
    const incoming = [...files];
    if (incoming.some((file) => !file.type.startsWith("image/"))) {
      setAttachmentError("Only images are supported right now.");
      return;
    }
    if (attachments.length + incoming.length > MAX_ATTACHMENTS) {
      setAttachmentError(`Attach up to ${MAX_ATTACHMENTS} images per turn.`);
      return;
    }
    if (incoming.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setAttachmentError("Each image must be smaller than 8 MB.");
      return;
    }
    const incomingBytes = incoming.reduce((sum, file) => sum + file.size, 0);
    const attachedBytes = attachments.reduce(
      (sum, part) => sum + attachmentBytes(part),
      0,
    );
    // Data URLs are larger than the raw file; the conservative limit here
    // leaves room for the JSON envelope and the rest of the conversation.
    if (attachedBytes + incomingBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      setAttachmentError("Keep the combined image size under 16 MB.");
      return;
    }
    try {
      const parts = await convertFileListToFileUIParts(files);
      setAttachments((current) => [...current, ...parts]);
    } catch {
      setAttachmentError("One of those images could not be read.");
    }
  };

  /** Replace a user turn and drop everything after it, then resend. */
  const editAndResend = (
    index: number,
    text: string,
    files: FileUIPart[],
  ) => {
    if (busy) return;
    clearError();
    stickRef.current = true;
    setMessages(messages.slice(0, index));
    sendMessage(
      { text, ...(files.length ? { files } : {}) },
      { body: requestBody() },
    );
  };

  const regenerateAt = (messageId: string) => {
    if (busy) return;
    clearError();
    stickRef.current = true;
    void regenerate({ messageId, body: requestBody() });
  };

  /** Fork the thread up to and including a message into a new conversation. */
  const branchAt = (index: number) => {
    onBranch(messages.slice(0, index + 1), settingsRef.current);
  };

  /** Esc stops a run — matches the composer's placeholder hint. */
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stopAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, stopAll]);

  useEffect(
    () => () => {
      imageAbortRef.current?.abort();
    },
    [],
  );

  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  const retry = () => {
    clearError();
    if (lastAssistant) regenerateAt(lastAssistant);
  };

  return (
    <>
      <div className="chat-scroll-region relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="dial-scroll relative min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        >
          <div
            ref={transcriptRef}
            className={`mx-auto w-full max-w-[760px] px-4 pb-5 pt-2 sm:px-7 ${
              messages.length === 0 ? "h-full" : ""
            }`}
          >
            {messages.length === 0 && (
              <EmptyState
                settings={settings}
                models={models}
                onOpenModel={onOpenSwitcher}
              />
            )}

            <div className="space-y-9">
              {messages.map((m, idx) => (
                <div key={m.id} data-message-index={idx}>
                  <MessageBubble
                    message={m}
                    streaming={
                      chatBusy &&
                      idx === messages.length - 1 &&
                      m.role === "assistant"
                    }
                    onEdit={
                      m.role === "user" && !busy
                        ? (text) =>
                            editAndResend(
                              idx,
                              text,
                              m.parts.filter(
                                (part): part is FileUIPart => part.type === "file",
                              ),
                            )
                        : undefined
                    }
                    onRegenerate={
                      m.role === "assistant" && !busy
                        ? () => regenerateAt(m.id)
                        : undefined
                    }
                    onBranch={
                      m.role === "assistant" && !busy
                        ? () => branchAt(idx)
                        : undefined
                    }
                    onRetryImage={
                      m.role === "assistant" && !busy
                        ? (image) => {
                            const previous = messages[idx - 1];
                            const references =
                              previous?.role === "user"
                                ? previous.parts.filter(
                                    (part): part is FileUIPart =>
                                      part.type === "file" &&
                                      isImageReference(part),
                                  )
                                : [];
                            void runImage(image.prompt, {
                              replaceMessageId: m.id,
                              references,
                            });
                          }
                        : undefined
                    }
                  />
                </div>
              ))}
            </div>

            {error && <ErrorPanel message={error.message} onRetry={retry} />}
          </div>
        </div>

        <MessageNavigator messages={messages} scrollRef={scrollRef} />
      </div>

      {/* jump to bottom — only while there's something to catch up with */}
      <AnimatePresence>
        {!atBottom && messages.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onClick={jumpToBottom}
            title="Jump to latest"
            className="pointer-events-auto absolute bottom-32 left-1/2 z-20 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-background/80 text-muted shadow-[0_8px_24px_rgba(0,0,0,0.2)] backdrop-blur-[20px] transition-colors hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      <div className="mx-auto w-full max-w-[760px]">
        <Composer
          input={input}
          setInput={updateComposerInput}
          onSend={send}
          onStop={stopAll}
          busy={busy}
          imageMode={imageMode}
          imageModel={activeImageModel}
          imageModelIsFallback={selectedImageModel === undefined}
          onSelectImageTool={selectImageTool}
          onRemoveImageTool={() => {
            setImageMode(false);
            setAttachmentError(null);
          }}
          settings={settings}
          onSettingsChange={onSettingsChange}
          models={models}
          onOpenSystemPrompt={() => setSystemOpen(true)}
          attachments={attachments}
          attachmentError={attachmentError}
          onAttachFiles={(files) => void addAttachments(files)}
          onHeightSettled={followLatest}
          onRemoveAttachment={(index) => {
            setAttachments((current) =>
              current.filter((_, currentIndex) => currentIndex !== index),
            );
            setAttachmentError(null);
          }}
        />
      </div>

      {systemOpen && (
        <SystemPrompt
          value={settings.system}
          onSave={(system) => onSettingsChange({ system })}
          onClose={() => setSystemOpen(false)}
        />
      )}
    </>
  );
}

/* ------------------------------- pieces ------------------------------- */

/**
 * Failure display.
 *
 * Two very different things land here and used to look identical: a rejection
 * from *this app's* route (returned as `{"error":"…"}`) and a genuine failure
 * from the provider (a bare string in the stream). Labelling both "upstream
 * error" — and printing the raw JSON — sent people to check OpenRouter for a
 * bug that was local.
 */
function describeError(raw: string): {
  title: string;
  detail: string;
  hint: string;
} {
  let detail = raw;
  let local = false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      detail = (parsed as { error: string }).error;
      local = true;
    }
  } catch {
    // Not JSON — an upstream message, already human-readable.
  }

  const hint = /provider\/model-slug|^model:/i.test(detail)
    ? "this conversation points at a model id this build won't accept — pick another (⌘K)"
    : /guardrail|data policy|privacy/i.test(detail)
      ? "restricted by your OpenRouter data policy — pick another model (⌘K)"
      : /rate|429|quota/i.test(detail)
        ? "rate limited upstream — wait a moment or switch model (⌘K)"
        : /credit|402|insufficient/i.test(detail)
          ? "out of OpenRouter credit — top up, or pick a free model (⌘K)"
          : /key|401|unauthor/i.test(detail)
            ? "check OPENROUTER_API_KEY in .env.local, then restart the dev server"
            : local
              ? "the request was rejected before it was sent"
              : "the request failed — retry, or switch model (⌘K)";

  return {
    title: local ? "request rejected" : "upstream error",
    detail,
    hint,
  };
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { title, detail, hint } = describeError(message);

  return (
    <div className="mt-4 rounded-xl border border-hairline bg-surface px-4 py-3 backdrop-blur-[20px]">
      <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
        {title}
      </p>
      <p className="mt-1 font-mono text-xs leading-relaxed text-foreground">
        {detail}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] leading-relaxed text-muted">{hint}</p>
        <button
          onClick={onRetry}
          className="shrink-0 rounded-full border border-hairline px-2.5 py-1 font-mono text-[10px] text-muted transition-colors hover:bg-background/40 hover:text-foreground"
        >
          retry
        </button>
      </div>
    </div>
  );
}

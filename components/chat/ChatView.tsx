"use client";

import { useChat } from "@ai-sdk/react";
import { convertFileListToFileUIParts, type FileUIPart } from "ai";
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
import { currentKey } from "@/lib/credentials";
import { generateImage } from "@/lib/image";
import { hasRenderableResponse } from "@/lib/messages";
import { OpenRouterChatTransport } from "@/lib/transport";
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
/**
 * Once the reader has cancelled the follow, they must come back this close
 * before it re-engages. The hysteresis exists for Safari's rubber-band: an
 * overscroll bounce settles *downward*, which without it looks exactly like
 * a deliberate return to the bottom and re-starts the following the reader
 * just cancelled.
 */
const RESTICK_THRESHOLD_PX = 24;
/**
 * How long after a wheel/touch/key gesture a scroll event is still credited
 * to the reader rather than to layout.
 */
const GESTURE_WINDOW_MS = 400;
/** Chat-pane width at which the transcript minimap earns its space. */
const NAVIGATOR_MIN_PX = 880;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;

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

  /**
   * Inference runs here, in the browser, against the user's own key. The
   * transport reads settings through the ref rather than capturing them, so
   * a mid-thread model switch takes effect on the very next turn.
   */
  const transport = useMemo(
    () => new OpenRouterChatTransport(settingsRef),
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
  const regionRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const scrollGeometryRef = useRef<{
    top: number;
    clientHeight: number;
  } | null>(null);
  /** When the reader last actually touched the scroll, as opposed to layout. */
  const gestureAtRef = useRef(0);

  /**
   * Pin after the DOM has its final measured height. The last streaming
   * render adds metrics/actions and can settle over more than one layout
   * pass, so a single effect-time `scrollTop` write is not sufficient.
   *
   * The explicit maximum is not a tidiness pass — it is the fix for a
   * Safari-only jump to the *top* of the transcript.
   *
   * `scrollTop = scrollHeight` reads as "go to the bottom" only because
   * browsers clamp the value to `scrollHeight - clientHeight`. When the
   * element is momentarily not scrollable that maximum is zero, so the write
   * lands at zero — the top — and nothing puts it back, because the next
   * `followLatest` only arrives on the following render.
   *
   * Safari resolves `flex-1 min-h-0` heights a layout pass later than Chrome,
   * so it hits that window on exactly the two occasions this misbehaved: the
   * relayout when a finished turn swaps in its metrics and actions, and the
   * ResizeObserver firing as the jump-to-bottom control mounts. Declining to
   * write when there is nothing to scroll is self-correcting — the observer
   * calls back once the layout settles.
   */
  const followLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    el.scrollTop = max;
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

    const fromReader = Date.now() - gestureAtRef.current < GESTURE_WINDOW_MS;

    // Growing the composer emits a scroll event even though the reader did
    // not scroll: scrollTop stays put while the viewport gets shorter. Do not
    // interpret that browser-generated event as an instruction to stop
    // following the answer. The ResizeObserver below will restore the bottom.
    //
    // `fromReader` guards it because the sub-pixel test is not safe on its
    // own. Safari reports a fractional `scrollTop` and a trackpad delivers
    // deltas well under a pixel, so a slow deliberate scroll satisfies
    // "moved less than 1px" and was being snapped back as if it were a
    // composer resize.
    if (
      !fromReader &&
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

    const distance = el.scrollHeight - current.top - current.clientHeight;

    // Scrolling up is an instruction, not a measurement. Deciding purely on
    // distance meant a small scroll up stayed inside the threshold, so the
    // next token dragged the reader back down — the thing they had just
    // tried to stop.
    const scrolledUp =
      fromReader && previous !== null && current.top < previous.top - 0.5;

    stickRef.current = scrolledUp
      ? false
      : distance <
        (stickRef.current ? STICK_THRESHOLD_PX : RESTICK_THRESHOLD_PX);

    // The control is about distance, not intent: it should not appear because
    // someone nudged the wheel two pixels.
    setAtBottom(distance < STICK_THRESHOLD_PX);
  };

  /**
   * Gate the minimap on the chat pane's own width.
   *
   * This replaces a CSS container query. `container-type` implies layout
   * containment, and having that on the scroll container's parent made
   * WebKit restore the scroll position on every re-layout — the Safari bug
   * where scrolling up jumped to the top and the jump-to-bottom control
   * snapped straight back. Measuring here costs one observer and writes an
   * attribute, so dragging the sidebar still re-renders nothing.
   */
  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      region.dataset.roomy = String(region.clientWidth >= NAVIGATOR_MIN_PX);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  /**
   * Distinguish a reader's scroll from a layout-driven one.
   *
   * A `scroll` event carries no hint about its origin, and the two need
   * opposite responses: one cancels the follow, the other should restore it.
   * Passive listeners, so none of this can delay Safari's scrolling.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const note = () => {
      gestureAtRef.current = Date.now();
    };
    el.addEventListener("wheel", note, { passive: true });
    el.addEventListener("touchmove", note, { passive: true });
    el.addEventListener("touchstart", note, { passive: true });
    el.addEventListener("keydown", note);
    return () => {
      el.removeEventListener("wheel", note);
      el.removeEventListener("touchmove", note);
      el.removeEventListener("touchstart", note);
      el.removeEventListener("keydown", note);
    };
  }, []);

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
    // Same clamp as followLatest: an unclamped scrollHeight is a request to
    // scroll past the end, which resolves to the top when there is no end.
    el.scrollTo({
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      behavior: "smooth",
    });
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
        const key = currentKey();
        if (!key) throw new Error("Connect an OpenRouter key to generate images.");

        const result = await generateImage({
          key,
          model: selectedImageModel,
          prompt: cleanPrompt,
          references: references.map((reference) => ({
            url: reference.url,
            mediaType: reference.mediaType,
          })),
          signal: controller.signal,
        });

        finalData = {
          status: "complete",
          prompt: cleanPrompt,
          model: result.model,
          images: result.images,
          startedAt,
          durationMs: result.durationMs,
          costUsd: result.usage.costUsd ?? null,
          error: null,
        };
        finalMetadata = {
          model: result.model,
          startedAt,
          durationMs: result.durationMs,
          costUsd: result.usage.costUsd,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
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
      sendMessage({ text, ...(attachments.length ? { files: attachments } : {}) });
    } else {
      sendMessage({ files: attachments });
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
    sendMessage({ text, ...(files.length ? { files } : {}) });
  };

  const regenerateAt = (messageId: string) => {
    if (busy) return;
    clearError();
    stickRef.current = true;
    void regenerate({ messageId });
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
      <div
        ref={regionRef}
        className="chat-scroll-region relative flex min-h-0 flex-1"
      >
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="dial-scroll relative min-w-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
        >
          <div
            ref={transcriptRef}
            className={`dial-column px-4 pb-5 pt-2 sm:px-7 ${
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

            <div className="dial-rows">
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

      <div className="dial-column">
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
 * Every error now originates in this tab — either from our own code before a
 * request is built, or from OpenRouter's response to one. Those two want
 * very different next actions, so the panel names which it is instead of
 * labelling everything "upstream" and printing whatever it was handed.
 */
function describeError(raw: string): {
  title: string;
  detail: string;
  hint: string;
} {
  const detail = raw.trim();
  // Raised by this app before anything is sent, so there is nothing upstream
  // to blame and nothing to retry until the user acts.
  const local = /connect (an|your) openrouter key/i.test(detail);

  const hint = local
    ? "no key is connected — connect one to continue"
    : // OpenRouter answers a bad or revoked key with "User not found." — a
      // literal 401 string almost never reaches here, and telling someone to
      // switch models when their key is dead sends them the wrong way.
      /\b401\b|unauthor|invalid api key|rejected this key|user not found|no auth credentials/i.test(
          detail,
        )
      ? "OpenRouter rejected the key — reconnect it from the model palette (⌘K)"
      : /credit|\b402\b|insufficient/i.test(detail)
        ? "out of OpenRouter credit — top up, or pick a free model (⌘K)"
        : /\b429\b|rate limit|too many requests/i.test(detail)
          ? "rate limited upstream — wait a moment or switch model (⌘K)"
          : /guardrail|data policy|privacy/i.test(detail)
            ? "restricted by your OpenRouter data policy — pick another model (⌘K)"
            : /provider\/model-slug|no endpoints|not a valid model/i.test(detail)
              ? "this conversation points at a model OpenRouter won't serve — pick another (⌘K)"
              : /failed to fetch|networkerror|load failed/i.test(detail)
                ? "the browser could not reach OpenRouter — check your connection"
                : "the request failed — retry, or switch model (⌘K)";

  return {
    title: local ? "not connected" : "request failed",
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

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
import SelectionActions from "./SelectionActions";
import Button from "@/components/ui/Button";
import Ocean from "@/components/ui/Ocean";
import Activity from "./Activity";
import type { DialMessage } from "@/lib/conversations";
import { capabilitiesFor } from "@/lib/capabilities";
import { currentKey } from "@/lib/credentials";
import { generateImage } from "@/lib/image";
import { promoteReasoningAnswer, reconcileFinishedResponse } from "@/lib/messages";
import { isStreamingRollback } from "@/lib/message-sync";
import { useHoldPage } from "@/lib/release";
import {
  askForKeyframe,
  askToStop,
  hasLivePeers,
  openFrame,
  publishFrame,
  subscribeLive,
} from "@/lib/live";
import {
  applyFrame,
  diffTail,
  overlay,
  tailOf,
  type FrameBody,
  type LiveTail,
} from "@/lib/live-frames";
import { OpenRouterChatTransport } from "@/lib/transport";
import {
  DEFAULT_IMAGE_MODEL,
  type ChatSettings,
  type GeneratedImageData,
  type OpenRouterModel,
  type RequestStatusData,
} from "@/lib/types";

/** How often the latest stream is offered to the cloud checkpoint throttle. */
const STREAM_SAVE_MS = 1200;
/** How often a streaming device mirrors its reply to the account's others. */
const LIVE_FRAME_MS = 180;
/** A stream with nothing new still says it is alive this often. */
const LIVE_HEARTBEAT_MS = 3000;
/** No frame for this long, and another device's stream is presumed gone. */
const LIVE_STALE_MS = 12_000;

/** Another device's stream into this thread, as last received. */
type RemoteStream = { stream: string; n: number; tail: LiveTail; at: number };
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
const PDF_TYPE = "application/pdf";
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
 * Cheap identity of a transcript: ids, shape, and how much text each part
 * holds. Enough to tell "the same thread" from "the thread moved on"
 * without walking every part twice, and enough to notice a streaming answer
 * that grew by a token.
 */
function fingerprint(messages: DialMessage[]): string {
  return messages
    .map((message) => {
      let size = 0;
      for (const part of message.parts) {
        if ("text" in part && typeof part.text === "string") {
          size += part.text.length;
        }
      }
      return `${message.id}:${message.parts.length}:${size}`;
    })
    .join("|");
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
  recentModels,
  onRecent,
  onOpenSwitcher,
  onBranch,
  saveTurn,
  loadThread,
  remoteVersion,
  setActiveId,
  userName,
  instructions,
}: {
  conversationId: string;
  settings: ChatSettings;
  onSettingsChange: (patch: Partial<ChatSettings>) => void;
  initialMessages: DialMessage[];
  models: OpenRouterModel[];
  /** Newest first, from the account's settings blob. */
  recentModels: readonly string[];
  onRecent: (next: string[]) => void;
  /** Open the full model palette, optionally already searching. */
  onOpenSwitcher: (query?: string) => void;
  onBranch: (messages: DialMessage[], settings: ChatSettings) => void;
  saveTurn: (o: {
    id: string;
    settings: ChatSettings;
    messages: DialMessage[];
    naming?: boolean;
    draft?: boolean;
  }) => Promise<void>;
  /** Read the thread, and which held messages another device deleted. */
  loadThread: (
    conversationId: string,
  ) => Promise<{ messages: DialMessage[]; removed: Set<string> }>;
  /** Increments when a sync applied remote records. See the effect below. */
  remoteVersion: number;
  setActiveId: (id: string) => void;
  /** For the empty state's greeting. */
  userName?: string;
  /** The account's standing instructions — the system prompt for every turn. */
  instructions: string;
}) {
  const [input, setInput] = useState("");
  /** Bumped to hand the caret back to the composer (after quoting). */
  const [composerFocus, setComposerFocus] = useState(0);
  const [attachments, setAttachments] = useState<FileUIPart[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /**
   * A save that did not reach the server.
   *
   * This failure mode is new. Writes used to land in IndexedDB and could not
   * realistically fail, so nothing needed to report it; they are requests
   * now, and there is no local copy behind them. Silently swallowing one
   * would mean the transcript on screen is the only copy in existence and
   * the user has no idea. So it is shown, with a retry.
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Remote reads wait until every local checkpoint/final save has settled. */
  const [pendingWrites, setPendingWrites] = useState(0);
  /** The last failed save, kept so `retry` can run exactly that write again. */
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);
  /**
   * Closed synchronously by onFinish, before React publishes `status=ready`.
   * This prevents an interval callback already waiting in the event loop from
   * queueing a stale draft after the final answer.
   */
  const streamSettledRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [imageMode, setImageMode] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const imageAbortRef = useRef<AbortController | null>(null);
  const setChatMessagesRef = useRef<((messages: DialMessage[]) => void) | null>(
    null,
  );
  /** Last transcript React rendered, used to settle SDK/realtime races. */
  const latestRef = useRef<DialMessage[]>(initialMessages);

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

  // Resolved here rather than at the point of use so the transport can be
  // handed the ref at construction. Same contract as settings: read through
  // a ref inside callbacks, synced after commit, never written during render.
  const selectedCapabilities = capabilitiesFor(settings.model, models);
  const capabilitiesRef = useRef(selectedCapabilities);
  useEffect(() => {
    capabilitiesRef.current = selectedCapabilities;
  });

  // Edited in settings while a thread is open, they apply from the next turn.
  const instructionsRef = useRef(instructions);
  useEffect(() => {
    instructionsRef.current = instructions;
  });

  /**
   * Inference runs here, in the browser, against the user's own key. The
   * transport reads settings through the ref rather than capturing them, so
   * a mid-thread model switch takes effect on the very next turn.
   */
  const transport = useMemo(
    () =>
      new OpenRouterChatTransport(settingsRef, capabilitiesRef, instructionsRef),
    [],
  );

  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } =
    useChat<DialMessage>({
      id: threadId,
      messages: initialMessages,
      transport,
      // At most one transcript update per frame-ish. Sources arrive ten at a
      // time and each was its own render of the whole view.
      throttle: 33,
      onFinish: ({ message, messages: finished, isAbort }) => {
        streamSettledRef.current = true;
        const reconciled = reconcileFinishedResponse(
          message,
          finished,
          latestRef.current,
        );
        // A model that answered on the reasoning channel: move the reply out
        // of the trace before it is saved, so the stored turn — and the
        // context the next request carries — has the answer as text.
        const promoted =
          !isAbort && reconciled.response
            ? promoteReasoningAnswer(reconciled.response)
            : null;
        if (promoted) {
          reconciled.messages = reconciled.messages.map((entry) =>
            entry.id === promoted.id ? promoted : entry,
          );
          reconciled.response = promoted;
        }
        const requestStatus = isAbort
          ? "interrupted"
          : reconciled.response
            ? null
            : "empty";
        const settled = requestStatus
          ? withRequestStatus(
              reconciled.messages,
              reconciled.response ?? message,
              requestStatus,
            )
          : reconciled.messages;

        if (settled !== finished || reconciled.response !== message) {
          setChatMessagesRef.current?.(settled);
        }
        // Write BEFORE announcing the thread. Flipping activeId first made
        // the shell read this conversation from D1 while the save was
        // still in flight, get nothing back, and blank the transcript — the
        // first exchange of a new thread vanished a beat after it arrived.
        void persist(
          {
            id: threadId,
            settings: settingsRef.current,
            messages: settled,
          },
          () => setActiveId(threadId),
        );
      },
    });

  useEffect(() => {
    setChatMessagesRef.current = setMessages;
  }, [setMessages]);

  /**
   * Save, and remember how to do it again if it fails.
   *
   * `after` runs only on success — for the first turn of a thread that is
   * `setActiveId`, and announcing a thread the server does not have would
   * put a row in the rail that opens to nothing.
   */
  const persist = useCallback(
    async (
      input: Parameters<typeof saveTurn>[0],
      after?: () => void,
    ): Promise<void> => {
      const run = async () => {
        setPendingWrites((count) => count + 1);
        try {
          await saveTurn(input);
          if (pendingSaveRef.current === run) {
            pendingSaveRef.current = null;
            setSaveError(null);
          }
          after?.();
        } finally {
          setPendingWrites((count) => Math.max(0, count - 1));
        }
      };
      pendingSaveRef.current = run;
      try {
        await run();
      } catch (error) {
        if (pendingSaveRef.current === run) {
          setSaveError(
            error instanceof Error ? error.message : "could not reach the server",
          );
        }
      }
    },
    [saveTurn],
  );

  const retrySave = useCallback(() => {
    const run = pendingSaveRef.current;
    if (!run) return;
    setSaveError(null);
    void run().catch((error: unknown) => {
      setSaveError(
        error instanceof Error ? error.message : "could not reach the server",
      );
    });
  }, []);

  const chatBusy = status === "streaming" || status === "submitted";
  const busy = chatBusy || imageBusy;
  // What closing the desktop app's window for a while must not throw away
  // (lib/release.ts). Typed text is checked there, from the page.
  useHoldPage(busy || pendingWrites > 0 || saveError !== null || attachments.length > 0);
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
  useEffect(() => {
    latestRef.current = messages;
  });

  useEffect(() => {
    if (!chatBusy) return;
    const timer = setInterval(() => {
      if (streamSettledRef.current) return;
      const snapshot = latestRef.current;
      if (snapshot.length === 0) return;
      // naming:false — a half-written thread isn't worth naming yet.
      void persist({
        id: threadId,
        settings: settingsRef.current,
        messages: snapshot,
        naming: false,
        draft: true,
      });
    }, STREAM_SAVE_MS);
    return () => clearInterval(timer);
  }, [chatBusy, persist, threadId]);

  /* --------------------------- remote changes --------------------------- */

  /**
   * Adopt what another device wrote into this thread.
   *
   * A realtime invalidation patches the rail, but useChat still owns the open
   * transcript in memory. Before this, cross-device sync looked broken because
   * nothing re-read the conversation in front of the reader.
   *
   * Three guards, each protecting against losing local work:
   *
   *  - Never while busy or while a save is in flight. A stream and its final
   *    unsaved snapshot are authoritative here; the version is re-checked
   *    when both settle, so nothing is dropped.
   *  - Never twice for the same version, which is what keeps the `busy`
   *    dependency from re-reading D1 the instant a stream finishes and
   *    racing the `onFinish` save that has not landed yet.
   *  - Never when the stored copy is missing a message we are holding. That
   *    means our own save is still in flight and the read is stale. The cost
   *    is that a *truncation* made on another device (an edit or a
   *    regenerate) waits for the next thread switch rather than applying
   *    live; losing a locally streamed answer would be far worse.
   */
  const appliedRemoteRef = useRef("0:0");
  /** Asks for a read outside the realtime signal — a live stream went quiet. */
  const [readNonce, setReadNonce] = useState(0);
  useEffect(() => {
    if (remoteVersion === 0 && readNonce === 0) return;
    if (busy || pendingWrites > 0 || saveError) return;
    const version = `${remoteVersion}:${readNonce}`;
    if (version === appliedRemoteRef.current) return;

    let cancelled = false;
    void loadThread(threadId)
      .catch(() => ({ messages: [] as DialMessage[], removed: new Set<string>() }))
      .then(({ messages: fresh, removed }) => {
      if (cancelled || fresh.length === 0) return;

      const local = latestRef.current;
      const stored = new Set(fresh.map((message) => message.id));
      // Missing from the server and known to have been there: another device
      // deleted it (an edit, a regenerate), and that applies here too. Missing
      // and never written: this device's own unsaved work — keep the screen.
      if (
        local.some((message) => !stored.has(message.id) && !removed.has(message.id))
      ) {
        return;
      }
      // A delayed checkpoint has the same message id and is a strict prefix
      // of the answer already on screen. Never let it roll a completed parent
      // device back to the child's partial cloud snapshot.
      if (isStreamingRollback(local, fresh)) return;
      if (fingerprint(fresh) === fingerprint(local)) {
        appliedRemoteRef.current = version;
        return;
      }

      appliedRemoteRef.current = version;
      latestRef.current = fresh;
      setMessages(fresh);
    });

    return () => {
      cancelled = true;
    };
  }, [remoteVersion, readNonce, busy, pendingWrites, saveError, loadThread, threadId, setMessages]);

  /* ----------------------------- live mirror ---------------------------- */

  /*
   * While this device streams, the reply is mirrored to the account's other
   * devices a few times a second (see lib/live-frames.ts); while another
   * device streams into this thread, its frames are laid over this
   * transcript, so the reply appears here as it is written rather than in
   * five-second checkpoints. The stored copy stays the authority: frames are
   * a view, and the realtime re-read replaces them once the turn is saved.
   */
  const stopAllRef = useRef<() => void>(() => undefined);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  });

  // Publishing. One stream per run of `chatBusy`.
  useEffect(() => {
    if (!chatBusy) return;
    const transcript = latestRef.current;
    // The turn starts at its user message: a send appends one, an edit
    // replaces one, a regenerate reuses one. Everything from there is live.
    let base = transcript.length;
    for (let index = transcript.length - 1; index >= 0; index--) {
      if (transcript[index].role === "user") {
        base = index;
        break;
      }
    }
    const stream = crypto.randomUUID().replace(/-/g, "");
    let n = 0;
    let sent: LiveTail | null = null;
    let keyframe = true;
    let lastAt = Date.now();
    let inFlight = false;
    let chain = Promise.resolve();

    const emit = (done: boolean) => {
      if (inFlight && !done) return;
      inFlight = true;
      chain = chain
        .then(async () => {
          if (!hasLivePeers()) return;
          const tail = tailOf(latestRef.current, base);
          const now = Date.now();
          const body: FrameBody | null = keyframe
            ? { kind: "key", tail }
            : (diffTail(sent, tail) ??
              (done || now - lastAt > LIVE_HEARTBEAT_MS ? { kind: "patch", patch: [] } : null));
          if (!body) return;
          const delivered = await publishFrame(threadId, {
            stream,
            n,
            body,
            ...(done ? { done: true } : {}),
          });
          // A frame that did not leave changes nothing: the next one is
          // diffed against what the other devices actually have.
          if (!delivered) return;
          n += 1;
          sent = tail;
          keyframe = false;
          lastAt = now;
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };

    const timer = setInterval(() => emit(false), LIVE_FRAME_MS);
    const unsubscribe = subscribeLive((message) => {
      if (message.thread !== threadId) return;
      if (message.t === "want") keyframe = true;
      if (message.t === "stop" && message.stream === stream) stopAllRef.current();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
      // The last frame carries the finished reply. onFinish publishes its
      // settled transcript a moment after the status flips, so wait for it.
      setTimeout(() => emit(true), 150);
    };
  }, [chatBusy, threadId]);

  // Receiving.
  const [remote, setRemote] = useState<RemoteStream | null>(null);
  const remoteRef = useRef<RemoteStream | null>(null);
  useEffect(() => {
    let chain = Promise.resolve();
    let askedAt = 0;
    let readFor: string | null = null;

    const settle = (final: RemoteStream | null) => {
      remoteRef.current = null;
      setRemote(null);
      if (!final) return;
      // Take the finished reply into this transcript now; the stored copy
      // replaces it when the other device's save is announced.
      const shown = overlay(latestRef.current, final.tail);
      if (shown) {
        latestRef.current = shown;
        setMessages(shown);
      }
    };

    const unsubscribe = subscribeLive((message) => {
      if (message.t !== "live" || message.thread !== threadId) return;
      chain = chain
        .then(async () => {
          // This device's own run is what this transcript shows.
          if (busyRef.current) return;
          const frame = await openFrame(message);
          if (!frame) return;
          const current = remoteRef.current;
          const tail =
            frame.body.kind === "key"
              ? frame.body.tail
              : current && current.stream === frame.stream && frame.n === current.n + 1
                ? applyFrame(current.tail, frame.body)
                : null;
          if (!tail) {
            // Joined mid-stream, or missed a frame: ask for a whole one.
            if (Date.now() - askedAt > 1000) {
              askedAt = Date.now();
              askForKeyframe(threadId);
            }
            return;
          }
          const next = { stream: frame.stream, n: frame.n, tail, at: Date.now() };
          if (frame.done) {
            settle(next);
            return;
          }
          // The tail belongs after messages this device has not read yet —
          // the turn's first checkpoint. Read once, then lay it over.
          if (!overlay(latestRef.current, tail) && readFor !== frame.stream) {
            readFor = frame.stream;
            setReadNonce((count) => count + 1);
          }
          remoteRef.current = next;
          setRemote(next);
        })
        .catch(() => undefined);
    });

    // Opening a thread another device is replying in: ask for a whole frame
    // now rather than waiting to notice a gap, so the reply goes live within
    // a frame instead of showing its last checkpoint as if it were finished.
    if (hasLivePeers()) askForKeyframe(threadId);

    // A device that vanished mid-stream sends no `done`. Fall back to what
    // it last saved.
    const watchdog = setInterval(() => {
      const current = remoteRef.current;
      if (current && Date.now() - current.at > LIVE_STALE_MS) {
        settle(null);
        setReadNonce((count) => count + 1);
      }
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(watchdog);
    };
  }, [threadId, setMessages]);

  /** What the transcript shows: this device's messages, with any live tail over them. */
  const remoteShown = remote ? overlay(messages, remote.tail) : null;
  const shown = remoteShown ?? messages;
  const remoteLive = remoteShown !== null;
  /** Busy here or elsewhere: either way, this thread is mid-reply. */
  const occupied = busy || remoteLive;

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

  /**
   * Recompute *only* the jump-to-bottom control.
   *
   * `atBottom` used to be written from `onScroll` alone, so it went stale
   * whenever the transcript grew without the reader touching it — which is
   * exactly what a sync does now that pulls reach the open thread. Nudging
   * the wheel a few pixels sets `stickRef` false while `atBottom` is still
   * true; content then arrives, `followLatest` declines to move (correctly,
   * the reader had scrolled), no scroll event fires, and the reader is left
   * far from the bottom with nothing offering to take them there.
   *
   * Deliberately a pure readout: it never writes `scrollTop` and never
   * touches `stickRef`, so the follow hysteresis and the Safari fixes above
   * are untouched by it.
   */
  const measureAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < STICK_THRESHOLD_PX);
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
    if (shown.length === 0) return;
    followLatest();

    // The SDK's finished state and the message's final UI do not always land
    // in the same layout pass. Re-pin on the next frame before the browser's
    // own scroll anchoring gets a chance to choose an older message.
    const frame = requestAnimationFrame(() => {
      followLatest();
      measureAtBottom();
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, status, followLatest, measureAtBottom]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const scroller = scrollRef.current;
    if (!transcript || !scroller || typeof ResizeObserver === "undefined") {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        followLatest();
        measureAtBottom();
      });
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
  }, [followLatest, measureAtBottom]);

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

  /** Quote a selection from an answer into the composer, ahead of any draft. */
  const quoteSelection = (text: string) => {
    const quoted = text
      .split("\n")
      .map((line) => `> ${line}`.trimEnd())
      .join("\n");
    setInput((current) =>
      current.trim() ? `${quoted}\n\n${current}` : `${quoted}\n\n`,
    );
    setComposerFocus((n) => n + 1);
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
      await persist(
        {
          id: threadId,
          settings: settingsRef.current,
          messages: finalMessages,
        },
        () => setActiveId(threadId),
      );
    },
    [
      attachments,
      activeImageModel,
      busy,
      persist,
      clearError,
      messages,
      selectedImageModel,
      setActiveId,
      setMessages,
      threadId,
    ],
  );

  const stopAll = useCallback(() => {
    if (imageAbortRef.current) imageAbortRef.current.abort();
    // The SDK's stop rejects with the abort it just caused; the stream's own
    // handlers already turned that into an interrupted turn.
    else void stop().catch(() => undefined);
  }, [stop]);
  useEffect(() => {
    stopAllRef.current = stopAll;
  });

  /** Stop: this device's run, or ask the device that is replying to stop. */
  const stopAny = useCallback(() => {
    if (busy) stopAll();
    else if (remote) askToStop(threadId, remote.stream);
  }, [busy, remote, stopAll, threadId]);

  const send = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || occupied) return;
    if (imageMode) {
      if (!text) {
        setAttachmentError("Describe the image you want to generate.");
        return;
      }
      void runImage(text);
      return;
    }
    if (
      !canSeeImages &&
      attachments.some((file) => file.mediaType.startsWith("image/"))
    ) {
      setAttachmentError("Choose a model with image input before sending.");
      return;
    }
    clearError();
    setAttachmentError(null);
    stickRef.current = true;
    streamSettledRef.current = false;
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
    if (
      incoming.some(
        (file) => !file.type.startsWith("image/") && file.type !== PDF_TYPE,
      )
    ) {
      setAttachmentError("Attach images or PDFs.");
      return;
    }
    // A PDF goes to any model — OpenRouter reads it first for models that
    // cannot. An image only goes to a model that advertises image input.
    if (
      !canSeeImages &&
      incoming.some((file) => file.type.startsWith("image/"))
    ) {
      setAttachmentError("This model accepts PDFs but not images.");
      return;
    }
    if (attachments.length + incoming.length > MAX_ATTACHMENTS) {
      setAttachmentError(`Attach up to ${MAX_ATTACHMENTS} files per turn.`);
      return;
    }
    if (incoming.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setAttachmentError("Each file must be smaller than 8 MB.");
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
      setAttachmentError("Keep the combined attachment size under 16 MB.");
      return;
    }
    try {
      const parts = await convertFileListToFileUIParts(files);
      setAttachments((current) => [...current, ...parts]);
    } catch {
      setAttachmentError("One of those files could not be read.");
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
    streamSettledRef.current = false;
    setMessages(messages.slice(0, index));
    sendMessage({ text, ...(files.length ? { files } : {}) });
  };

  const regenerateAt = (messageId: string) => {
    if (busy) return;
    clearError();
    stickRef.current = true;
    streamSettledRef.current = false;
    void regenerate({ messageId });
  };

  /** Fork the thread up to and including a message into a new conversation. */
  const branchAt = (index: number) => {
    onBranch(messages.slice(0, index + 1), settingsRef.current);
  };

  /*
   * The bubbles' handlers. MessageBubble is memoized so a streamed token
   * re-renders only the message it belongs to, and that only works if every
   * bubble receives the same functions on every render. So they are stable
   * and take the message's index, and the work they do is read through a ref
   * synced after commit — the latest `messages`, never a captured one.
   */
  const bubbleActions = {
    edit: (index: number, text: string) =>
      editAndResend(
        index,
        text,
        messages[index]?.parts.filter(
          (part): part is FileUIPart => part.type === "file",
        ) ?? [],
      ),
    regenerate: (index: number) => {
      const id = messages[index]?.id;
      if (id) regenerateAt(id);
    },
    branch: (index: number) => branchAt(index),
    retryImage: (index: number, image: GeneratedImageData) => {
      const previous = messages[index - 1];
      const references =
        previous?.role === "user"
          ? previous.parts.filter(
              (part): part is FileUIPart =>
                part.type === "file" && isImageReference(part),
            )
          : [];
      void runImage(image.prompt, {
        replaceMessageId: messages[index]?.id,
        references,
      });
    },
  };
  const bubbleActionsRef = useRef(bubbleActions);
  useEffect(() => {
    bubbleActionsRef.current = bubbleActions;
  });
  const onBubbleEdit = useCallback(
    (index: number, text: string) => bubbleActionsRef.current.edit(index, text),
    [],
  );
  const onBubbleRegenerate = useCallback(
    (index: number) => bubbleActionsRef.current.regenerate(index),
    [],
  );
  const onBubbleBranch = useCallback(
    (index: number) => bubbleActionsRef.current.branch(index),
    [],
  );
  const onBubbleRetryImage = useCallback(
    (index: number, image: GeneratedImageData) =>
      bubbleActionsRef.current.retryImage(index, image),
    [],
  );

  /** Esc stops a run — matches the composer's placeholder hint. */
  useEffect(() => {
    if (!occupied) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stopAny();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [occupied, stopAny]);

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
    // The chat's own stacking context, so the empty state's ocean can sit
    // at -z under the transcript and the composer — above the window's
    // background, below everything drawn on it — without lifting either.
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <AnimatePresence>
        {shown.length === 0 && (
          <motion.div
            key="ocean"
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <Ocean className="h-full w-full" />
          </motion.div>
        )}
      </AnimatePresence>

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
              shown.length === 0 ? "h-full" : ""
            }`}
          >
            {shown.length === 0 && (
              <EmptyState
                settings={settings}
                models={models}
                userName={userName}
                onOpenModel={() => onOpenSwitcher()}
              />
            )}

            <div className="dial-rows">
              {shown.map((m, idx) => (
                <div key={m.id} data-message-index={idx}>
                  <MessageBubble
                    message={m}
                    index={idx}
                    streaming={
                      (chatBusy || remoteLive) &&
                      idx === shown.length - 1 &&
                      m.role === "assistant"
                    }
                    onEdit={m.role === "user" && !occupied ? onBubbleEdit : undefined}
                    onRegenerate={
                      m.role === "assistant" && !occupied ? onBubbleRegenerate : undefined
                    }
                    onBranch={m.role === "assistant" && !occupied ? onBubbleBranch : undefined}
                    onRetryImage={
                      m.role === "assistant" && !occupied ? onBubbleRetryImage : undefined
                    }
                  />
                </div>
              ))}

              {/* Between send and the first streamed chunk there is no
                  assistant message to hang a status on, and the transcript
                  used to sit silent. The same loader the thinking header
                  uses — the same component, at the same offset — so the
                  hand-off when the message arrives is seamless. */}
              {(chatBusy || remoteLive) && shown[shown.length - 1]?.role === "user" && (
                <div className="pb-1">
                  <div className="dial-activity-block mb-3">
                    <Activity steps={[]} live since={undefined} canSearch={false} />
                  </div>
                  {/* Where the reply's metrics row will be, so taking over
                      moves nothing while the transcript is pinned to the
                      bottom. */}
                  <div className="min-h-8" />
                </div>
              )}
            </div>

            {error && <ErrorPanel message={error.message} onRetry={retry} />}
            {saveError && <SaveErrorPanel message={saveError} onRetry={retrySave} />}
          </div>
        </div>

        <MessageNavigator messages={shown} scrollRef={scrollRef} />
      </div>

      {/* jump to bottom — only while there's something to catch up with */}
      <AnimatePresence>
        {!atBottom && shown.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onClick={jumpToBottom}
            title="Jump to latest"
            aria-label="Jump to latest"
            className="pointer-events-auto absolute bottom-32 left-1/2 z-20 flex size-8 -translate-x-1/2 items-center justify-center rounded-full bg-panel text-secondary shadow-raised transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.94]"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      <div
        className="composer-dock dial-column"
        data-empty={shown.length === 0 ? "true" : undefined}
      >
        <Composer
          focusToken={composerFocus}
          input={input}
          setInput={updateComposerInput}
          onSend={send}
          onStop={stopAny}
          busy={occupied}
          elsewhere={remoteLive && !busy}
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
          recentModels={recentModels}
          onRecent={onRecent}
          onOpenCatalog={onOpenSwitcher}
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

      <SelectionActions containerRef={transcriptRef} onQuote={quoteSelection} />
    </div>
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

/**
 * The answer arrived; storing it did not.
 *
 * Deliberately worded so the reader knows the reply on screen is real and
 * the risk is losing it, which is a different problem from the request
 * having failed — and a different fix.
 */
function SaveErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Notice
      title="Not saved"
      detail={message}
      hint="This reply is only in this tab until it reaches your account — keep it open."
      onRetry={onRetry}
    />
  );
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
    <Notice
      title={title.charAt(0).toUpperCase() + title.slice(1)}
      detail={detail}
      hint={hint.charAt(0).toUpperCase() + hint.slice(1)}
      onRetry={onRetry}
    />
  );
}

/** A failure, as a card: what happened, the raw detail, and the way out. */
function Notice({
  title,
  detail,
  hint,
  onRetry,
}: {
  title: string;
  detail: string;
  hint: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-5 overflow-hidden rounded-card bg-panel shadow-card"
      style={{ animation: "dial-fade-up 260ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M8 4.5v4M8 11.25v.01" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-foreground">{title}</p>
          <p className="mt-1 break-words font-mono text-[12px] leading-relaxed text-secondary">
            {detail}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line bg-hover px-4 py-2.5">
        <p className="text-[12.5px] leading-relaxed text-muted">{hint}</p>
        <Button variant="secondary" size="xs" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

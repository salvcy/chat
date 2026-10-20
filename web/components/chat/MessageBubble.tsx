"use client";

import Image from "next/image";
import type { FileUIPart } from "ai";
import { motion } from "motion/react";
import { memo, useEffect, useRef, useState } from "react";
import GeneratedImage from "./GeneratedImage";
import Markdown from "./Markdown";
import FileGlyph from "./FileGlyph";
import MessageActions from "./MessageActions";
import Metrics from "./Metrics";
import Activity from "./Activity";
import type { DialMessage } from "@/lib/conversations";
import { enterToSend } from "@/lib/keys";
import { textOf } from "@/lib/store";
import { answerTextOf, buildTimeline, WORK_KEY, type Block } from "@/lib/timeline";
import {
  hasRenderableResponse,
  inferRequestStatus,
  promoteReasoningAnswer,
  streamNeverFinished,
} from "@/lib/messages";
import type { GeneratedImageData, RequestStatusData } from "@/lib/types";
import Button from "@/components/ui/Button";

/** New messages: fade + 4px slide-up, 150ms ease-out. */
const enter = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.15, ease: "easeOut" as const },
};

/**
 * True when (x, y) is on a visible character of `root`'s text — not on the
 * whitespace between paragraphs, past the end of a line, or in padding.
 */
function pointIsOnWord(root: HTMLElement, x: number, y: number): boolean {
  let node: Node | null = null;
  let offset = 0;
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const range = document.caretRangeFromPoint?.(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return false;
  const text = node.textContent ?? "";
  // The caret lands between characters; the click is on one of its two
  // neighbours, if either is a visible glyph that actually contains the point.
  for (const at of [offset - 1, offset]) {
    if (at < 0 || at >= text.length || !/\S/.test(text[at])) continue;
    const glyph = document.createRange();
    glyph.setStart(node, at);
    glyph.setEnd(node, at + 1);
    const rect = glyph.getBoundingClientRect();
    if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top && y <= rect.bottom) {
      return true;
    }
  }
  return false;
}

/**
 * Multi-click selection inside a user bubble, made exact.
 *
 * Left to the browser, a double-click on the blank line between two
 * paragraphs — or past the end of a line, or in the padding — selected the
 * newline there and painted a stray bar of highlight in empty space; and a
 * triple-click ran the selection out of the bubble into whatever followed,
 * which WebKit paints as bands across the gap. A double-click on a word still
 * selects that word. Anything else, and every triple-click, selects exactly
 * the message: its text and nothing after it.
 */
function selectBubbleText(
  event: React.MouseEvent<HTMLElement>,
  text: HTMLElement | null,
) {
  if (event.button !== 0 || event.detail < 2 || !text) return;
  if ((event.target as Element).closest("button")) return;
  if (event.detail === 2 && pointIsOnWord(text, event.clientX, event.clientY)) return;
  event.preventDefault();
  const range = document.createRange();
  range.selectNodeContents(text);
  const apply = () => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  apply();
  // A press inside an existing selection defers collapsing it to the
  // release — which would clear this one. Re-assert once that has run.
  window.addEventListener("mouseup", () => setTimeout(apply, 0), { once: true });
}

function requestStatusText(kind: RequestStatusData["kind"]): string {
  return kind === "interrupted"
    ? "Request was interrupted by the user."
    : "No response was returned.";
}

/**
 * The terminal-state line for a turn that produced nothing (or stopped short).
 *
 * A dead-end turn with no way forward is its own kind of broken, so this
 * carries the retry itself rather than relying on the hover actions, which
 * only appear once there's an answer to act on.
 */
function RequestStatusLine({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p role="status" className="flex items-center gap-2 text-[13.5px] leading-relaxed text-muted">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
          <circle cx="8" cy="8" r="5.75" />
          <path d="M8 5v3.25M8 10.75v.01" />
        </svg>
        {text}
      </p>
      {onRetry && (
        <Button variant="secondary" size="xs" onClick={onRetry}>
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" />
            <path d="M13.5 2.5V6H10" />
          </svg>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * One message. Assistant messages are bare markdown prose on the page — no
 * bubble, no background. User messages are the only bubbles, right-aligned.
 * An assistant turn renders as its timeline: the work — thinking, searching,
 * and what the model said along the way — as one activity block, then the
 * answer and its measured metrics. Sources live in the activity, not under
 * the answer. The asymmetry is deliberate.
 *
 * Memoized, and every callback takes the message's index rather than closing
 * over it, so ChatView can hand each bubble the same functions on every
 * render. A streamed token used to re-render every message in the thread —
 * timeline, metrics, sources — and on a long thread that was most of the
 * main thread while an answer streamed.
 */
const MessageBubble = memo(function MessageBubble({
  message,
  index,
  streaming,
  onRegenerate,
  onEdit,
  onBranch,
  onRetryImage,
}: {
  message: DialMessage;
  index: number;
  streaming: boolean;
  onRegenerate?: (index: number) => void;
  onEdit?: (index: number, text: string) => void;
  onBranch?: (index: number) => void;
  onRetryImage?: (index: number, image: GeneratedImageData) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /** Long pasted prompts start folded, so the answer is not a scroll away. */
  const [unfolded, setUnfolded] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [editing]);

  /* ------------------------------- user ------------------------------- */

  if (message.role === "user") {
    const text = textOf(message);
    const long = text.length > 1400 || text.split("\n").length > 14;
    const folded = long && !unfolded;
    const files = message.parts.filter(
      (part): part is FileUIPart => part.type === "file",
    );

    if (editing) {
      const commit = () => {
        const next = draft.trim();
        setEditing(false);
        // Resending identical text would just burn a request.
        if (next && next !== text) onEdit?.(index, next);
      };
      return (
        <motion.div {...enter} className="flex justify-end">
          <div className="w-full max-w-[88%] sm:max-w-[80%]">
            <div className="rounded-[18px] bg-panel px-4 py-3 shadow-raised">
              <textarea
                ref={editRef}
                value={draft}
                aria-label="Edit message"
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = "0px";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
                }}
                onKeyDown={(e) => {
                  enterToSend(e, commit);
                  if (e.key === "Escape") setEditing(false);
                }}
                className="dial-scroll max-h-[320px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-foreground outline-none"
              />
            </div>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <span className="mr-1 hidden items-center gap-1 text-[11.5px] text-muted sm:flex">
                <span className="dial-kbd">⏎</span> resend
                <span className="dial-kbd ml-1.5">esc</span> cancel
              </span>
              <Button variant="quiet" size="xs" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="xs" onClick={commit}>
                Resend
              </Button>
            </div>
          </div>
        </motion.div>
      );
    }

    return (
      <motion.div {...enter} className="group flex justify-end">
        <div className="relative max-w-[84%] sm:max-w-[78%]">
          <div className="overflow-hidden rounded-[18px] rounded-br-[6px] bg-field shadow-hairline">
            {files.length > 0 && (
              <div
                className={`grid select-none gap-1.5 p-1.5 ${
                  files.length > 1 ? "grid-cols-2" : "grid-cols-1"
                }`}
              >
                {files.map((file, index) =>
                  file.mediaType.startsWith("image/") && file.url ? (
                    <Image
                      key={`${file.url.slice(0, 40)}-${index}`}
                      unoptimized
                      src={file.url}
                      alt={file.filename ?? `Attachment ${index + 1}`}
                      width={320}
                      height={220}
                      className="max-h-56 w-full rounded-[13px] object-cover"
                    />
                  ) : file.url ? (
                    <div
                      key={`${file.url.slice(0, 40)}-${index}`}
                      title={file.filename ?? undefined}
                      className="flex items-center gap-2.5 rounded-card bg-panel px-3 py-2.5 text-muted shadow-hairline"
                    >
                      <FileGlyph kind={file.mediaType} className="shrink-0" />
                      <span className="min-w-0 truncate font-mono text-[11px]">
                        {file.filename ?? "attachment"}
                      </span>
                    </div>
                  ) : (
                    <div
                      key={`missing-${index}`}
                      className="rounded-card bg-panel px-3 py-2 font-mono text-[11px] text-muted shadow-hairline"
                    >
                      attachment unavailable on this device
                    </div>
                  ),
                )}
              </div>
            )}
            {text && (
              /* Padding belongs on the wrapper, never on the element holding
                 the text. A selection highlights whole line boxes, and a
                 padded paragraph's line boxes begin 16px before the first
                 character and end 16px past the last — so selecting a message
                 painted a band of empty space all around it. */
              <div
                className="px-4 py-2.5"
                onMouseDown={(event) => selectBubbleText(event, textRef.current)}
              >
                <p
                  ref={textRef}
                  className={`whitespace-pre-wrap text-[15px] leading-relaxed text-foreground ${
                    folded
                      ? "max-h-[13.5em] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_65%,transparent)]"
                      : ""
                  }`}
                >
                  {text}
                </p>
                {long && (
                  <button
                    type="button"
                    onClick={() => setUnfolded((open) => !open)}
                    aria-expanded={!folded}
                    className="-mb-1 -ml-1.5 mt-1 flex h-6 select-none items-center gap-1 rounded-chip px-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-hover-2 hover:text-foreground"
                  >
                    {folded ? "Show more" : "Show less"}
                    <svg viewBox="0 0 12 12" className={`h-2.5 w-2.5 transition-transform duration-200 ${folded ? "" : "rotate-180"}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
          {/* Hung in the row gap rather than below the bubble: reserving a
              line for controls that are invisible until hover pushed every
              answer a full row further from its question. */}
          <div className="absolute right-0 top-full z-10 mt-1 flex select-none items-center justify-end gap-1">
            <MessageActions
              text={text}
              align="right"
              onEdit={
                onEdit && text
                  ? () => {
                      setDraft(text);
                      setEditing(true);
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </motion.div>
    );
  }

  if (message.role !== "assistant") return null;
  // Turns saved before reasoning-channel answers were promoted at finish:
  // show the reply where a reader expects it rather than inside the trace.
  const turn = (!streaming && promoteReasoningAnswer(message)) || message;

  /* ---------------------------- assistant ----------------------------- */

  const canSearch = turn.metadata?.search === true;
  const blocks = buildTimeline(turn, { streaming, holdRemarks: canSearch });
  // Sent, and nothing to show yet: an empty block of work under the key the
  // real one will have, so the first step grows into it instead of
  // replacing it — and it looks exactly like the placeholder ChatView shows
  // before this message existed, so that hand-off is seamless too.
  const shown: Block[] =
    streaming && blocks.length === 0 ? [{ kind: "activity", key: WORK_KEY, steps: [] }] : blocks;
  // Whitespace is not an answer, and neither is a remark the model made on
  // its way back to thinking — the timeline folds both into the work.
  const answerStarted = blocks.some((block) => block.kind === "text");
  const regenerate = onRegenerate ? () => onRegenerate(index) : undefined;
  const startedAt = turn.metadata?.startedAt;
  const firstThinking = blocks.findIndex(
    (block) =>
      block.kind === "activity" &&
      block.steps.some((step) => step.kind === "thought"),
  );

  // What Copy copies: the answer, not the remarks folded into the work.
  const answerText = answerTextOf(blocks);
  const hasGeneratedImage = turn.parts.some(
    (part) => part.type === "data-image",
  );
  const requestStatus = turn.parts.find(
    (part) => part.type === "data-requestStatus",
  );

  // Failsafe. `onFinish` tags interrupted/empty turns, but it never runs when
  // the tab is closed or reloaded mid-answer — and rows written before that
  // mechanism existed carry no tag at all. Without a render-time check those
  // land in the transcript as a blank gap with no explanation and no way out.
  const untaggedDeadEnd =
    !streaming && !requestStatus && !hasRenderableResponse(turn);
  // A turn that *did* produce text but never reached its finish event is
  // truncated rather than empty; say so under the partial answer.
  //
  // Scoped to streamed text on purpose: a failed image generation also ends
  // up with no `durationMs`, and GeneratedImage already renders its own error
  // and retry — adding a "cut off" line there would be both wrong and doubled.
  const truncated =
    !streaming &&
    !requestStatus &&
    !untaggedDeadEnd &&
    !hasGeneratedImage &&
    answerStarted &&
    streamNeverFinished(turn);

  const statusText =
    requestStatus?.type === "data-requestStatus"
      ? requestStatusText(requestStatus.data.kind)
      : untaggedDeadEnd
        ? requestStatusText(inferRequestStatus(turn))
        : truncated
          ? "Response was cut off before it finished."
          : null;
  const isDeadEnd = untaggedDeadEnd || requestStatus !== undefined;

  return (
    <motion.div
      {...enter}
      // A streaming reply takes over from ChatView's placeholder in place;
      // fading it in would blink the header that was already there.
      initial={streaming ? false : enter.initial}
      data-selectable="assistant"
      className={`group max-w-full pb-1 ${streaming ? "dial-streaming" : ""}`}
    >
      {shown.map((block, at) => {
        if (block.kind === "text") return <Markdown key={block.key} text={block.text} />;
        if (block.kind === "image") {
          const data = block.part.data;
          return (
            <GeneratedImage
              key={block.key}
              data={data}
              onRetry={
                data.status === "error" && onRetryImage
                  ? () => onRetryImage(index, data)
                  : undefined
              }
            />
          );
        }
        const last = at === shown.length - 1;
        return (
          <div key={block.key} className={`dial-activity-block ${at === 0 ? "mb-3" : "my-3"}`}>
            <Activity
              steps={block.steps}
              // Still working while it is the newest thing in the turn, or
              // while a thought inside it is open.
              live={
                streaming &&
                (last ||
                  block.steps.some((step) => step.kind === "thought" && step.live))
              }
              since={startedAt}
              fallbackMs={at === firstThinking ? turn.metadata?.thinkingMs : undefined}
              canSearch={canSearch}
            />
          </div>
        );
      })}

      {statusText && (
        <RequestStatusLine
          text={statusText}
          onRetry={!streaming ? regenerate : undefined}
        />
      )}

      <div className="flex min-h-8 items-center justify-between gap-3">
        {!hasGeneratedImage && !isDeadEnd && (
          <Metrics meta={turn.metadata} streaming={streaming} />
        )}
        {!streaming && answerStarted && (
          <MessageActions
            text={answerText}
            onRegenerate={regenerate}
            onBranch={onBranch ? () => onBranch(index) : undefined}
          />
        )}
      </div>
    </motion.div>
  );
});

export default MessageBubble;

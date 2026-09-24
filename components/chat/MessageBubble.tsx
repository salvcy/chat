"use client";

import Image from "next/image";
import type { FileUIPart, SourceUrlUIPart } from "ai";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import Citations from "./Citations";
import GeneratedImage from "./GeneratedImage";
import Markdown from "./Markdown";
import FileGlyph from "./FileGlyph";
import MessageActions from "./MessageActions";
import Metrics from "./Metrics";
import ThinkingPanel from "./ThinkingPanel";
import type { DialMessage } from "@/lib/conversations";
import { textOf } from "@/lib/store";
import { dedupeSources } from "@/lib/sources";
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

function isToolPart(p: DialMessage["parts"][number]): boolean {
  return (
    p.type === "dynamic-tool" ||
    (typeof p.type === "string" && p.type.startsWith("tool-"))
  );
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
 * bubble, no background. User messages are the only bubbles: a right-aligned
 * glass pill. Reasoning and web search render as telemetry panels, sources
 * as footnotes, and every assistant turn carries its measured metrics. The
 * asymmetry is deliberate.
 */
export default function MessageBubble({
  message,
  streaming,
  onRegenerate,
  onEdit,
  onBranch,
  onRetryImage,
}: {
  message: DialMessage;
  streaming: boolean;
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
  onBranch?: () => void;
  onRetryImage?: (image: GeneratedImageData) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /** Long pasted prompts start folded, so the answer is not a scroll away. */
  const [unfolded, setUnfolded] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

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
        if (next && next !== text) onEdit?.(next);
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
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    commit();
                  }
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
                className={`grid gap-1.5 p-1.5 ${
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
              <div className="px-4 py-2.5">
                <p
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
                    className="-mb-1 -ml-1.5 mt-1 flex h-6 items-center gap-1 rounded-chip px-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-hover-2 hover:text-foreground"
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
          <div className="absolute right-0 top-full z-10 mt-1 flex items-center justify-end gap-1">
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
  if (!streaming) {
    const promoted = promoteReasoningAnswer(message);
    if (promoted) message = promoted;
  }

  /* ---------------------------- assistant ----------------------------- */

  // Whitespace is not an answer: some models emit a bare newline mid-think.
  const answerStarted = message.parts.some(
    (p) => p.type === "text" && p.text.trim().length > 0,
  );
  // Reasoning can resume after the answer has begun; while a reasoning part
  // is still open, the model is thinking, whatever came before it.
  const reasoningOpen = message.parts.some(
    (p) => p.type === "reasoning" && p.state === "streaming",
  );
  const sources = dedupeSources(
    message.parts.filter(
      (p): p is SourceUrlUIPart => p.type === "source-url",
    ),
  );
  // One trace, not one panel per reasoning part — providers emit several.
  const reasoning = message.parts
    .filter((p) => p.type === "reasoning")
    .map((p) => (p.type === "reasoning" ? p.text : ""))
    .join("\n\n");

  const answerText = textOf(message);
  const hasGeneratedImage = message.parts.some(
    (part) => part.type === "data-image",
  );
  const requestStatus = message.parts.find(
    (part) => part.type === "data-requestStatus",
  );

  // Failsafe. `onFinish` tags interrupted/empty turns, but it never runs when
  // the tab is closed or reloaded mid-answer — and rows written before that
  // mechanism existed carry no tag at all. Without a render-time check those
  // land in the transcript as a blank gap with no explanation and no way out.
  const untaggedDeadEnd =
    !streaming && !requestStatus && !hasRenderableResponse(message);
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
    streamNeverFinished(message);

  const statusText =
    requestStatus?.type === "data-requestStatus"
      ? requestStatusText(requestStatus.data.kind)
      : untaggedDeadEnd
        ? requestStatusText(inferRequestStatus(message))
        : truncated
          ? "Response was cut off before it finished."
          : null;
  const isDeadEnd = untaggedDeadEnd || requestStatus !== undefined;

  return (
    <motion.div
      {...enter}
      data-selectable="assistant"
      className={`group max-w-full pb-1 ${streaming ? "dial-streaming" : ""}`}
    >
      <ThinkingPanel
        reasoning={reasoning}
        sources={sources}
        thinkingMs={message.metadata?.thinkingMs}
        startedAt={message.metadata?.startedAt}
        streaming={streaming}
        answerStarted={answerStarted}
        reasoningOpen={reasoningOpen}
      />

      {message.parts.map((part, i) => {
        // Reasoning and sources are shown together by ThinkingPanel above.
        if (part.type === "reasoning" || part.type === "source-url") return null;
        if (isToolPart(part)) return null;
        if (part.type === "data-requestStatus") return null;
        if (part.type === "text") return <Markdown key={i} text={part.text} />;
        if (part.type === "data-image") {
          return (
            <GeneratedImage
              key={part.id ?? i}
              data={part.data}
              onRetry={
                part.data.status === "error" && onRetryImage
                  ? () => onRetryImage(part.data)
                  : undefined
              }
            />
          );
        }
        return null;
      })}

      {statusText && (
        <RequestStatusLine
          text={statusText}
          onRetry={!streaming ? onRegenerate : undefined}
        />
      )}

      <Citations sources={sources} />

      <div className="flex min-h-8 items-center justify-between gap-3">
        {!hasGeneratedImage && !isDeadEnd && (
          <Metrics meta={message.metadata} streaming={streaming} />
        )}
        {!streaming && answerStarted && (
          <MessageActions
            text={answerText}
            onRegenerate={onRegenerate}
            onBranch={onBranch}
          />
        )}
      </div>
    </motion.div>
  );
}

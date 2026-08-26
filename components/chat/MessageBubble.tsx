"use client";

import Image from "next/image";
import type { FileUIPart, SourceUrlUIPart } from "ai";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import Citations from "./Citations";
import GeneratedImage from "./GeneratedImage";
import Markdown from "./Markdown";
import MessageActions from "./MessageActions";
import Metrics from "./Metrics";
import ThinkingPanel from "./ThinkingPanel";
import type { DialMessage } from "@/lib/conversations";
import { textOf } from "@/lib/db";
import { dedupeSources } from "@/lib/sources";
import {
  hasRenderableResponse,
  inferRequestStatus,
  streamNeverFinished,
} from "@/lib/messages";
import type { GeneratedImageData, RequestStatusData } from "@/lib/types";

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
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <p role="status" className="text-[13px] italic leading-relaxed text-muted">
        {text}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          retry
        </button>
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
          <div className="w-full max-w-[84%] sm:max-w-[78%]">
            <div className="rounded-[20px] border border-hairline-strong bg-surface-strong px-4 py-3">
              <textarea
                ref={editRef}
                value={draft}
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
            <div className="mt-1.5 flex items-center justify-end gap-2 font-mono text-[10px] text-muted">
              <span>⏎ resend · esc cancel</span>
              <button
                onClick={() => setEditing(false)}
                className="rounded-md px-1.5 py-0.5 transition-colors hover:text-foreground"
              >
                cancel
              </button>
              <button
                onClick={commit}
                className="rounded-md bg-invert-fill px-2 py-0.5 text-invert-text"
              >
                resend
              </button>
            </div>
          </div>
        </motion.div>
      );
    }

    return (
      <motion.div {...enter} className="group flex justify-end">
        <div className="max-w-[84%] sm:max-w-[78%]">
          <div className="overflow-hidden rounded-[20px] rounded-br-md border border-hairline-strong bg-surface-strong">
            {files.length > 0 && (
              <div
                className={`grid gap-1.5 p-1.5 ${
                  files.length > 1 ? "grid-cols-2" : "grid-cols-1"
                }`}
              >
                {files.map((file, index) =>
                  file.mediaType.startsWith("image/") ? (
                    <Image
                      key={`${file.url.slice(0, 40)}-${index}`}
                      unoptimized
                      src={file.url}
                      alt={file.filename ?? `Attachment ${index + 1}`}
                      width={320}
                      height={220}
                      className="max-h-56 w-full rounded-[15px] object-cover"
                    />
                  ) : (
                    <div
                      key={`${file.url.slice(0, 40)}-${index}`}
                      className="rounded-xl border border-hairline bg-background/35 px-3 py-2 font-mono text-[10px] text-muted"
                    >
                      {file.filename ?? "attachment"}
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
              <div className="px-4 py-3">
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                  {text}
                </p>
              </div>
            )}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1">
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

  /* ---------------------------- assistant ----------------------------- */

  const answerStarted = message.parts.some(
    (p) => p.type === "text" && p.text.length > 0,
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
    <motion.div {...enter} className="group max-w-full pb-1">
      <ThinkingPanel
        reasoning={reasoning}
        sources={sources}
        thinkingMs={message.metadata?.thinkingMs}
        streaming={streaming}
        answerStarted={answerStarted}
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

      <div className="flex items-center justify-between gap-3">
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

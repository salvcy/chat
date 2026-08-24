"use client";

import type { SourceUrlUIPart, UIMessage } from "ai";
import { motion } from "motion/react";
import Citations from "./Citations";
import Markdown from "./Markdown";
import ReasoningPanel from "./ReasoningPanel";
import SearchPanel from "./SearchPanel";

/** New messages: fade + 4px slide-up, 150ms ease-out. */
const enter = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.15, ease: "easeOut" as const },
};

function timeOf(id: string): string {
  const t = Number(id.split("-")[0]);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function isToolPart(p: UIMessage["parts"][number]): boolean {
  return (
    p.type === "dynamic-tool" ||
    (typeof p.type === "string" && p.type.startsWith("tool-"))
  );
}

/**
 * One message. Assistant messages are bare markdown prose on the page —
 * no bubble, no background. User messages are the only bubbles: a
 * right-aligned glass pill. Reasoning and web-search render as telemetry
 * panels; sources become a footnote block. The asymmetry is deliberate.
 */
export default function MessageBubble({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  const time = timeOf(message.id);

  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    return (
      <motion.div {...enter} className="flex justify-end">
        <div className="max-w-[82%]">
          <div className="rounded-[18px] rounded-br-md border border-hairline bg-surface px-4 py-2.5 backdrop-blur-[20px]">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
              {text}
            </p>
          </div>
          <p className="mt-1 text-right font-mono text-[10px] text-muted">
            {time}
          </p>
        </div>
      </motion.div>
    );
  }

  if (message.role !== "assistant") return null;

  const answerStarted = message.parts.some(
    (p) => p.type === "text" && p.text.length > 0,
  );
  const sources = message.parts.filter(
    (p): p is SourceUrlUIPart => p.type === "source-url",
  );
  const hasReasoning = message.parts.some((p) => p.type === "reasoning");
  const searching =
    streaming && !answerStarted && !hasReasoning && sources.length === 0;

  return (
    <motion.div {...enter} className="max-w-full">
      {(searching || sources.length > 0) && (
        <SearchPanel sources={sources} searching={searching} />
      )}
      {message.parts.map((part, i) => {
        if (part.type === "reasoning") {
          return (
            <ReasoningPanel
              key={i}
              text={part.text}
              streaming={streaming}
              answerStarted={answerStarted}
            />
          );
        }
        if (isToolPart(part)) return null;
        if (part.type === "text") {
          return <Markdown key={i} text={part.text} />;
        }
        return null;
      })}
      <Citations sources={sources} />
      {time && answerStarted && (
        <p className="mt-2 font-mono text-[10px] italic text-muted">{time}</p>
      )}
    </motion.div>
  );
}

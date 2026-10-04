"use client";

import { AnimatePresence, motion } from "motion/react";
import type { RefObject } from "react";
import { useMemo, useState } from "react";
import type { DialMessage } from "@/lib/conversations";
import { textOf } from "@/lib/store";

type NavigatorItem = {
  id: string;
  messageIndex: number;
  role: "user" | "assistant";
  preview: string;
  width: number;
};

function previewOf(message: DialMessage): string {
  const text = textOf(message)
    .replace(/```[\w+-]*\n?/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text.slice(0, 220);

  const image = message.parts.find((part) => part.type === "data-image");
  if (image?.type === "data-image") {
    return image.data.status === "complete"
      ? `Generated image: ${image.data.prompt}`
      : image.data.status === "error"
        ? `Image failed: ${image.data.prompt}`
        : `Generating image: ${image.data.prompt}`;
  }

  const requestStatus = message.parts.find(
    (part) => part.type === "data-requestStatus",
  );
  if (requestStatus?.type === "data-requestStatus") {
    return requestStatus.data.kind === "interrupted"
      ? "Request interrupted by you"
      : "No response returned";
  }

  const files = message.parts.filter((part) => part.type === "file").length;
  if (files > 0) return `${files} attachment${files === 1 ? "" : "s"}`;
  return message.role === "assistant" ? "Generating a response…" : "Message";
}

/**
 * A quiet transcript minimap. Markers stay small until they are useful:
 * hover/focus reveals a preview, and selecting one jumps to that message.
 */
export default function MessageNavigator({
  messages,
  scrollRef,
}: {
  messages: DialMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const items = useMemo<NavigatorItem[]>(
    () =>
      messages.flatMap((message, messageIndex) => {
        if (message.role !== "user" && message.role !== "assistant") return [];
        const preview = previewOf(message);
        return [
          {
            id: message.id,
            messageIndex,
            role: message.role,
            preview,
            width:
              message.role === "user"
                ? 14
                : Math.min(18, 9 + Math.round(preview.length / 38)),
          },
        ];
      }),
    [messages],
  );

  if (items.length < 2) return null;

  const gap = items.length > 48 ? 0 : items.length > 24 ? 1 : 2;
  const markerHeight = items.length > 48 ? 3 : items.length > 24 ? 4 : 6;

  const jumpTo = (item: NavigatorItem) => {
    const scroller = scrollRef.current;
    const target = scroller?.querySelector<HTMLElement>(
      `[data-message-index="${item.messageIndex}"]`,
    );
    if (!scroller || !target) return;
    scroller.scrollTo({
      top: Math.max(0, target.offsetTop - 24),
      behavior: "smooth",
    });
  };

  return (
    <nav
      aria-label="Message navigator"
      className="message-navigator pointer-events-none absolute bottom-4 right-2 top-4 z-30 w-14"
    >
      <div
        className="flex h-full flex-col justify-center"
        style={{ gap: `${gap}px` }}
      >
        {items.map((item, index) => {
          const showingPreview = previewIndex === index;
          const hoverDistance =
            previewIndex === null
              ? Number.POSITIVE_INFINITY
              : Math.abs(index - previewIndex);
          const hoverGrowth =
            hoverDistance === 0
              ? 28
              : hoverDistance === 1
                ? 14
                : hoverDistance === 2
                  ? 6
                  : hoverDistance === 3
                    ? 2
                    : 0;
          const markerWidth = Math.min(44, item.width + hoverGrowth);
          const markerThickness =
            hoverDistance === 0 ? 3.5 : hoverDistance <= 2 ? 2.5 : 2;
          const markerOpacity =
            hoverDistance === 0
              ? 0.92
              : hoverDistance === 1
                ? 0.72
                : hoverDistance === 2
                  ? 0.56
                  : hoverDistance === 3
                    ? 0.44
                    : 0.34;
          const edge = index / Math.max(1, items.length - 1);
          const previewPosition =
            edge < 0.18
              ? "top-0"
              : edge > 0.82
                ? "bottom-0"
                : "top-1/2 -translate-y-1/2";

          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Jump to ${item.role === "user" ? "your" : "model"} message ${index + 1}: ${item.preview}`}
              onClick={() => jumpTo(item)}
              onMouseEnter={() => setPreviewIndex(index)}
              onMouseLeave={() => setPreviewIndex(null)}
              onFocus={() => setPreviewIndex(index)}
              onBlur={() => setPreviewIndex(null)}
              className="pointer-events-auto group relative flex shrink-0 items-center justify-end focus-visible:shadow-none"
              style={{ height: `${markerHeight}px` }}
            >
              <motion.span
                aria-hidden="true"
                animate={{
                  width: markerWidth,
                  height: markerThickness,
                  opacity: markerOpacity,
                }}
                transition={{
                  type: "spring",
                  stiffness: 520,
                  damping: 34,
                  mass: 0.45,
                }}
                className="block rounded-full bg-foreground"
              />

              <AnimatePresence>
                {showingPreview && (
                  <motion.span
                    role="tooltip"
                    initial={{ opacity: 0, x: 5, scale: 0.98 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 4, scale: 0.98 }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                    className={`pointer-events-none absolute right-12 flex w-72 flex-col rounded-card bg-panel p-3.5 text-left shadow-overlay ${previewPosition}`}
                  >
                    <span className="mb-1.5 flex items-center justify-between gap-3 font-mono text-[10.5px] text-muted">
                      <span>{item.role === "user" ? "you" : "model"}</span>
                      <span>{index + 1} / {items.length}</span>
                    </span>
                    <span className="line-clamp-3 text-[13px] leading-relaxed text-secondary">
                      {item.preview}
                    </span>
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

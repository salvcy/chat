"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import {
  formatCost,
  formatDuration,
  formatThroughput,
  formatTime,
  formatTokens,
} from "@/lib/format";
import { shortModelId } from "@/lib/capabilities";
import type { DialMetadata } from "@/lib/types";

/**
 * The per-message flight recorder.
 *
 * Every number here was measured by the server and streamed down as message
 * metadata — none of it is estimated in the browser. Collapsed it reads as a
 * single quiet mono line (the tok/s + cost the README always promised);
 * expanded it gives the full token split and routing.
 */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

export default function Metrics({
  meta,
  streaming,
}: {
  meta: DialMetadata | undefined;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Nothing measured yet — a row of dashes would just be noise.
  if (!meta || (!meta.durationMs && !meta.ttftMs && !streaming)) return null;

  const summary: string[] = [];
  if (meta.tokensPerSecond) summary.push(formatThroughput(meta.tokensPerSecond));
  if (meta.durationMs) summary.push(formatDuration(meta.durationMs));
  if (meta.costUsd !== undefined) summary.push(formatCost(meta.costUsd));

  // While streaming, the only honest reading is time-to-first-token.
  if (summary.length === 0) {
    if (meta.ttftMs) summary.push(`ttft ${formatDuration(meta.ttftMs)}`);
    else return null;
  }

  const detail: Array<[string, string]> = [];
  if (meta.model) detail.push(["model", shortModelId(meta.model)]);
  if (meta.provider) detail.push(["via", meta.provider]);
  if (meta.ttftMs) detail.push(["ttft", formatDuration(meta.ttftMs)]);
  if (meta.promptTokens !== undefined) {
    detail.push(["in", formatTokens(meta.promptTokens)]);
  }
  if (meta.cachedTokens) detail.push(["cached", formatTokens(meta.cachedTokens)]);
  if (meta.completionTokens !== undefined) {
    detail.push(["out", formatTokens(meta.completionTokens)]);
  }
  if (meta.reasoningTokens) {
    detail.push(["thought", formatTokens(meta.reasoningTokens)]);
  }
  if (meta.effort && meta.effort !== "off") detail.push(["effort", meta.effort]);
  if (meta.answerInReasoning) detail.push(["answer", "sent as reasoning"]);
  // "stop" is the boring case; only surface a stop reason worth knowing.
  if (meta.finishReason && meta.finishReason !== "stop") {
    detail.push(["stopped", meta.finishReason]);
  }

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group -mx-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 whitespace-nowrap rounded-control px-1.5 py-1 font-mono text-[11px] tabular-nums text-muted transition-colors hover:bg-hover hover:text-secondary"
        title={open ? "Hide telemetry" : "Show telemetry"}
      >
        {meta.startedAt && (
          <span>{formatTime(meta.startedAt)}</span>
        )}
        {summary.map((s, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="opacity-40">·</span>
            <span className={streaming && i === 0 ? "dial-shimmer" : ""}>
              {s}
            </span>
          </span>
        ))}
        {detail.length > 0 && (
          <svg
            viewBox="0 0 12 12"
            className={`h-2.5 w-2.5 opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-70 ${open ? "rotate-180 opacity-70" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
          </svg>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && detail.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mb-1 mt-1 inline-flex flex-wrap gap-x-4 gap-y-1.5 rounded-card bg-hover px-3 py-2 font-mono text-[11px] tabular-nums">
              {detail.map(([label, value]) => (
                <Field key={label} label={label} value={value} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

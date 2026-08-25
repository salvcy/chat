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
      <span className="text-muted/70">{label}</span>
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
  if (meta.search) detail.push(["search", "on"]);
  // "stop" is the boring case; only surface a stop reason worth knowing.
  if (meta.finishReason && meta.finishReason !== "stop") {
    detail.push(["stopped", meta.finishReason]);
  }

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-2 font-mono text-[10px] text-muted transition-colors hover:text-foreground"
        title={open ? "Hide telemetry" : "Show telemetry"}
      >
        {meta.startedAt && (
          <span className="italic">{formatTime(meta.startedAt)}</span>
        )}
        {summary.map((s, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-hairline">·</span>
            <span className={streaming && i === 0 ? "dial-shimmer" : ""}>
              {s}
            </span>
          </span>
        ))}
        {detail.length > 0 && (
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.15 }}
            className="opacity-0 transition-opacity group-hover:opacity-60"
          >
            ▾
          </motion.span>
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
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-l border-hairline py-1 pl-3 font-mono text-[10px]">
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

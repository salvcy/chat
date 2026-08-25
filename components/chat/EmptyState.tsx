"use client";

import { motion } from "motion/react";
import { formatContext, formatInOutPrice } from "@/lib/format";
import { modelFor, shortModelId } from "@/lib/capabilities";
import type { ChatSettings, OpenRouterModel } from "@/lib/types";

/**
 * The empty state is an invitation, not a logo screen.
 *
 * It gives the blank canvas one useful piece of context — what the selected
 * model can do — and otherwise gets out of the way.
 */
export default function EmptyState({
  settings,
  models,
  onOpenModel,
}: {
  settings: ChatSettings;
  models: OpenRouterModel[];
  onOpenModel: () => void;
}) {
  const model = modelFor(settings.model, models);
  const compactPrice = formatInOutPrice(model)
    .replace(/\.00/g, "")
    .replace(" M tok", "/M");
  const detail = [
    model?.contextLength ? formatContext(model.contextLength) : null,
    compactPrice,
    model?.capabilities.reasoning ? "think" : null,
    model?.capabilities.tools ? "web" : null,
    model?.capabilities.vision ? "vision" : null,
    model?.capabilities.imageGeneration ? "image" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className="empty-state flex h-full flex-col items-center justify-center px-2 py-10 text-center"
    >
      <h1 className="text-balance text-[28px] font-medium leading-tight tracking-[-0.035em] text-foreground sm:text-[34px]">
        What are you working on?
      </h1>

      <button
        onClick={onOpenModel}
        className="group mt-5 flex max-w-full items-center gap-3 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-hairline-strong hover:bg-surface-strong"
        title="Change model (⌘K)"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/55" />
        <span className="min-w-0">
          <span className="block truncate text-[12px] text-secondary">
            {model?.name ?? shortModelId(settings.model)}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9px] text-muted">
            {detail || "capabilities loading…"}
          </span>
        </span>
        <span className="font-mono text-[11px] text-muted opacity-45 transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </button>
    </motion.section>
  );
}

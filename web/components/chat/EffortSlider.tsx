"use client";

import StepSlider from "@/components/ui/StepSlider";
import type { ReasoningEffort } from "@/lib/types";

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};

export const EFFORT_DESCRIPTION: Record<ReasoningEffort, string> = {
  off: "Answers straight away, without thinking first.",
  minimal: "A quick check before answering.",
  low: "Thinks briefly. Fast and inexpensive.",
  medium: "A balance of depth and speed.",
  high: "Thinks longer on hard problems.",
  xhigh: "As deep as this model goes. Slowest and costliest.",
};

/**
 * How hard the model thinks: exactly the model's efforts, low to high, as a
 * stepped slider (see StepSlider for why it moves in detents).
 */
export default function EffortSlider({
  value,
  options,
  onChange,
}: {
  value: ReasoningEffort;
  /** Exactly what the model accepts, low→high — `effortOptions(caps)`. */
  options: ReasoningEffort[];
  onChange: (next: ReasoningEffort) => void;
}) {
  return (
    <StepSlider
      label="Reasoning effort"
      value={value}
      options={options}
      onChange={onChange}
      valueText={(option) => EFFORT_LABEL[option]}
    />
  );
}

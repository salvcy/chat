import type { OpenRouterModel } from "@/lib/types";

/** "$3.00/M" from a per-token USD string; "free" when zero. */
export function formatPricePerMillion(perToken: string | null): string {
  if (perToken === null) return "—";
  const n = Number.parseFloat(perToken);
  if (Number.isNaN(n)) return "—";
  if (n === 0) return "free";
  const perM = n * 1e6;
  return `$${perM >= 100 ? perM.toFixed(0) : perM.toFixed(2)}/M`;
}

/** "$3/$15 M" compact in/out for the tuner strip. */
export function formatInOutPrice(m: OpenRouterModel | undefined): string {
  if (!m) return "";
  const pin = formatPricePerMillion(m.promptPrice).replace("/M", "");
  const pout = formatPricePerMillion(m.completionPrice).replace("/M", "");
  if (pin === "free" && pout === "free") return "free";
  return `${pin}/${pout} M tok`;
}

/** "1M" / "200k" context shorthand. */
export function formatContext(tokens: number | null): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

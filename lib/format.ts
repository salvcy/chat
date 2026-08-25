import type { OpenRouterModel } from "@/lib/types";

/**
 * Display helpers for the instrument readouts. Everything formatted here is
 * a *measured* value and renders in mono — the formatting exists so numbers
 * of wildly different magnitude (nanodollars, millions of tokens) still line
 * up as something scannable.
 */

/** "$3.00/M" from a per-token USD string; "free" when zero. */
export function formatPricePerMillion(perToken: string | null): string {
  if (perToken === null) return "—";
  const n = Number.parseFloat(perToken);
  if (Number.isNaN(n)) return "—";
  if (n === 0) return "free";
  const perM = n * 1e6;
  if (perM < 1) return `$${perM.toFixed(2)}/M`;
  return `$${perM >= 100 ? perM.toFixed(0) : perM.toFixed(2)}/M`;
}

/** "$3/$15 M tok" compact in/out, for the tuner readout. */
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

/**
 * Cost, honestly. A single cheap turn can land at $0.00004 — rounding that
 * to "$0.00" would tell the user the app is free, so sub-cent amounts get
 * enough precision to stay true, and anything smaller still reads "<$0.0001"
 * rather than zero.
 */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || Number.isNaN(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** "1.2k" / "847" — token counts, compact. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "820ms" / "4.2s" / "1m 12s" — latency and duration. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "42 tok/s". */
export function formatThroughput(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps)) return "—";
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

/** Clock time for a message stamp. */
export function formatTime(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Sidebar date grouping. Relative for the recent past — where "3 days ago"
 * is more useful than a date — then absolute once it stops being relative.
 */
export function groupForDate(ts: number, now = Date.now()): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= startOfToday) return "today";
  if (ts >= startOfToday - day) return "yesterday";
  if (ts >= startOfToday - 7 * day) return "this week";
  if (ts >= startOfToday - 30 * day) return "this month";
  return new Date(ts).toLocaleDateString([], {
    month: "long",
    year: "numeric",
  });
}

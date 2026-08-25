import type { SourceUrlUIPart } from "ai";

/**
 * Helpers for provider-returned web-search sources.
 *
 * The provider commonly cites the *same* URL several times in one answer, and
 * sets `sourceId` to the URL — so keying a list on it produced duplicate React
 * keys. Deduping here fixes that and makes the source count mean "how many
 * distinct pages", which is the number worth showing.
 */

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Provider excerpts can be garbled UTF-8 — fall back to the domain. */
export function labelOf(s: SourceUrlUIPart): string {
  const title = s.title?.trim();
  if (title && !/[^\x00-\x7F]{3,}/.test(title)) return title;
  return domainOf(s.url);
}

/** Collapse tracking variants of the same page into one citation. */
function canonicalSourceKey(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
    for (const key of [...url.searchParams.keys()]) {
      if (
        key.startsWith("utm_") ||
        ["fbclid", "gclid", "ref", "ref_src"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return raw;
  }
}

/** Distinct sources, first occurrence wins — safe to key on `url`. */
export function dedupeSources(sources: SourceUrlUIPart[]): SourceUrlUIPart[] {
  const seen = new Map<string, SourceUrlUIPart>();
  for (const s of sources) {
    const key = canonicalSourceKey(s.url);
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}

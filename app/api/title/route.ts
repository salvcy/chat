import { generateText } from "ai";
import { openrouter } from "@/lib/openrouter";
import { titleRequestSchema } from "@/lib/schema";

/**
 * POST /api/title — name a conversation.
 *
 * The old `deriveTitle` sliced the first 80 characters of the opening
 * message, which turns a pasted stack trace into an unreadable sidebar row.
 * A cheap fast model reads the exchange and names it instead. The client
 * falls back to the truncated form if this fails, so it is never blocking.
 */

/** Cheap + fast; the whole job is five words. Overridable via env. */
const TITLE_MODEL =
  process.env.OPENROUTER_TITLE_MODEL ?? "google/gemini-2.5-flash-lite";
const MAX_TITLE_BODY_BYTES = 12 * 1024;

const SYSTEM = [
  "You name chat conversations.",
  "Reply with a title of 2-5 words describing the topic.",
  "No quotes, no trailing punctuation, no preamble.",
  "Use sentence case. Never answer the question itself.",
].join(" ");

/** Strip the things small models add anyway: quotes, periods, "Title:". */
function clean(raw: string): string {
  return raw
    .trim()
    .split("\n")[0]
    .replace(/^(title|topic)\s*[:—-]\s*/i, "")
    .replace(/^["'“”‘’]|["'“”‘’.]+$/g, "")
    .trim()
    .slice(0, 60);
}

export async function POST(req: Request) {
  const declaredSize = Number(req.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_TITLE_BODY_BYTES) {
    return Response.json(
      { error: "title request is too large" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  let raw: unknown;
  try {
    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > MAX_TITLE_BODY_BYTES) {
      return Response.json(
        { error: "title request is too large" },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    raw = JSON.parse(body);
  } catch {
    raw = null;
  }

  const parsed = titleRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid title request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { prompt, reply } = parsed.data;

  try {
    const { text } = await generateText({
      model: openrouter(TITLE_MODEL),
      system: SYSTEM,
      prompt: reply
        ? `User: ${prompt}\n\nAssistant: ${reply.slice(0, 600)}`
        : `User: ${prompt}`,
      maxOutputTokens: 24,
      temperature: 0.2,
      abortSignal: req.signal,
    });

    const title = clean(text);
    if (!title) throw new Error("empty title");
    return Response.json(
      { title },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Non-fatal by design — the client keeps its local fallback title.
    return Response.json(
      { error: err instanceof Error ? err.message : "title generation failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

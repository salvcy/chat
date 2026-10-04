import assert from "node:assert/strict";
import test from "node:test";
import type { TextStreamPart, ToolSet } from "ai";
import { orderStream, reasoningIn } from "../lib/reasoning-stream.ts";

type Part = TextStreamPart<ToolSet>;

/** A raw OpenRouter chunk, as the provider hands it through. */
function raw(delta: Record<string, unknown>): Part {
  return { type: "raw", rawValue: { choices: [{ index: 0, delta }] } };
}

async function run(parts: Part[]): Promise<Part[]> {
  const out: Part[] = [];
  const reader = new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  })
    .pipeThrough(orderStream())
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

/**
 * Replays parts the way useChat assembles them — a part is placed when it
 * starts and grows where it sits — so a test can assert on what the reader
 * would actually see, in order.
 */
function assemble(parts: Part[]): Array<{ type: "text" | "reasoning"; text: string }> {
  const placed: Array<{ type: "text" | "reasoning"; text: string }> = [];
  const open = new Map<string, { type: "text" | "reasoning"; text: string }>();
  for (const part of parts) {
    if (part.type === "text-start" || part.type === "reasoning-start") {
      const entry = { type: part.type === "text-start" ? "text" as const : "reasoning" as const, text: "" };
      assert.ok(!open.has(`${entry.type}:${part.id}`), `${part.type} ${part.id} opened twice`);
      open.set(`${entry.type}:${part.id}`, entry);
      placed.push(entry);
    } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
      const kind = part.type === "text-delta" ? "text" : "reasoning";
      const entry = open.get(`${kind}:${part.id}`);
      assert.ok(entry, `${part.type} for unopened ${part.id}`);
      entry.text += part.text;
    } else if (part.type === "text-end" || part.type === "reasoning-end") {
      const kind = part.type === "text-end" ? "text" : "reasoning";
      assert.ok(open.delete(`${kind}:${part.id}`), `${part.type} for unopened ${part.id}`);
    }
  }
  return placed;
}

test("reasoning text is read from details first, then the flat field", () => {
  const detailed = { choices: [{ delta: { reasoning: "flat", reasoning_details: [{ type: "reasoning.text", text: "rich" }] } }] };
  assert.equal(reasoningIn(detailed), "rich");
  assert.equal(reasoningIn({ choices: [{ delta: { reasoning: "flat" } }] }), "flat");
  assert.equal(
    reasoningIn({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] } }] }),
    "",
  );
});

test("reasoning the provider already emits is never duplicated", async () => {
  const out = await run([
    raw({ reasoning: "thinking " }),
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text: "thinking " },
    raw({ content: "Answer" }),
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "Answer" },
    { type: "text-end", id: "t" },
  ]);
  assert.deepEqual(assemble(out), [
    { type: "reasoning", text: "thinking " },
    { type: "text", text: "Answer" },
  ]);
  assert.ok(!out.some((part) => part.type === "raw"));
});

test("a stray newline mid-thought neither opens the answer nor drops the thinking", async () => {
  const out = await run([
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text: "first " },
    raw({ content: "\n\n" }),
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "\n\n" },
    // The provider drops these two; the transform must not.
    raw({ reasoning: "still " }),
    raw({ reasoning_details: [{ type: "reasoning.text", text: "thinking" }] }),
    raw({ content: "Answer" }),
    { type: "text-delta", id: "t", text: "Answer" },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} as never },
  ]);

  // The answer sits after all of the thinking, not above the second half.
  assert.deepEqual(assemble(out), [
    { type: "reasoning", text: "first " },
    { type: "reasoning", text: "still thinking" },
    { type: "text", text: "\n\nAnswer" },
  ]);
});

test("thinking that resumes after real text splits the answer in time order", async () => {
  const out = await run([
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "Part one.\n\n" },
    raw({ reasoning: "wait, check that" }),
    raw({ content: "Part two." }),
    { type: "text-delta", id: "t", text: "Part two." },
    { type: "text-end", id: "t" },
  ]);
  assert.deepEqual(assemble(out), [
    { type: "text", text: "Part one.\n\n" },
    { type: "reasoning", text: "wait, check that" },
    { type: "text", text: "Part two." },
  ]);
});

test("whitespace-only content never becomes a text part", async () => {
  const out = await run([
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text: "the whole reply, on the reasoning channel" },
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "\n" },
    { type: "text-end", id: "t" },
  ]);
  assert.ok(!out.some((part) => part.type.startsWith("text-")));
});

test("a resumed thought is closed if the stream ends mid-thought", async () => {
  const out = await run([
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: " " },
    raw({ reasoning: "cut off" }),
  ]);
  assert.equal(out.at(-1)?.type, "reasoning-end");
  assert.deepEqual(assemble(out), [{ type: "reasoning", text: "cut off" }]);
});

test("sources do not split the answer", async () => {
  const out = await run([
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "Cited " },
    { type: "source", sourceType: "url", id: "s", url: "https://example.com", title: "Example" },
    { type: "text-delta", id: "t", text: "claim." },
    { type: "text-end", id: "t" },
  ]);
  assert.deepEqual(assemble(out), [{ type: "text", text: "Cited claim." }]);
});

const cite = (url: string): Part => ({ type: "source", sourceType: "url", id: url, url, title: url });

test("thinking that resumes after a search lands after the sources", async () => {
  const out = await run([
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text: "Check the docs. " },
    cite("https://a.example"),
    cite("https://b.example"),
    { type: "reasoning-delta", id: "r", text: "They agree." },
    { type: "reasoning-end", id: "r", providerMetadata: { openrouter: { reasoning_details: [] } } },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "Answer" },
    { type: "text-end", id: "t" },
  ]);
  const order = out
    .filter((part) => part.type === "reasoning-start" || part.type === "source" || part.type === "text-start")
    .map((part) => part.type);
  assert.deepEqual(order, ["reasoning-start", "source", "source", "reasoning-start", "text-start"]);
  assert.deepEqual(assemble(out), [
    { type: "reasoning", text: "Check the docs. " },
    { type: "reasoning", text: "They agree." },
    { type: "text", text: "Answer" },
  ]);
  // The provider's closing metadata stays on the thought it closes.
  const end = out.find((part) => part.type === "reasoning-end" && part.providerMetadata);
  assert.equal(end?.type === "reasoning-end" && end.id, "r:1");
});

test("a search that ends the thinking does not split it", async () => {
  const out = await run([
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text: "Look it up." },
    cite("https://a.example"),
    { type: "reasoning-end", id: "r", providerMetadata: { openrouter: { reasoning_details: [] } } },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "Answer" },
    { type: "text-end", id: "t" },
  ]);
  const ends = out.filter((part) => part.type === "reasoning-end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].type === "reasoning-end" && ends[0].id, "r");
  assert.ok(ends[0].type === "reasoning-end" && ends[0].providerMetadata);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { TextStreamPart, ToolSet } from "ai";
import { reasoningIn, reviveLateReasoning } from "../lib/reasoning-stream.ts";

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
    .pipeThrough(reviveLateReasoning())
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
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
  const reasoning = out.filter((part) => part.type === "reasoning-delta");
  assert.equal(reasoning.length, 1);
  assert.ok(!out.some((part) => part.type === "raw"));
});

test("reasoning after a stray newline is revived and closed by real text", async () => {
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

  const late = out.filter(
    (part): part is Extract<Part, { type: "reasoning-delta" }> =>
      part.type === "reasoning-delta" && part.id !== "r",
  );
  assert.deepEqual(late.map((part) => part.text), ["still ", "thinking"]);

  const types = out.map((part) => part.type);
  const lateEnd = out.findIndex(
    (part) => part.type === "reasoning-end" && part.id !== "r",
  );
  const answer = out.findIndex(
    (part) => part.type === "text-delta" && part.text === "Answer",
  );
  assert.ok(lateEnd >= 0 && lateEnd < answer, types.join(","));
});

test("a revived reasoning part is closed if the stream ends mid-thought", async () => {
  const out = await run([
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: " " },
    raw({ reasoning: "cut off" }),
  ]);
  assert.equal(out.at(-1)?.type, "reasoning-end");
});

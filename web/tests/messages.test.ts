import assert from "node:assert/strict";
import test from "node:test";
import {
  messagesForTextModel,
  promoteReasoningAnswer,
  reconcileFinishedResponse,
  type DialMessage,
} from "../lib/messages.ts";

function user(id: string, text: string): DialMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text = ""): DialMessage {
  return {
    id,
    role: "assistant",
    parts: text ? [{ type: "text", text }] : [],
  };
}

test("a rendered response wins over an empty finish callback message", () => {
  const prompt = user("user-1", "Explain CUDA");
  const empty = assistant("assistant-1");
  const rendered = assistant("assistant-1", "CUDA schedules kernels on the GPU.");

  const result = reconcileFinishedResponse(
    empty,
    [prompt, empty],
    [prompt, rendered],
  );

  assert.equal(result.response?.parts[0].type, "text");
  assert.deepEqual(result.messages, [prompt, rendered]);
});

test("the richest matching streamed snapshot is persisted", () => {
  const prompt = user("user-1", "Explain CUDA");
  const partial = assistant("assistant-1", "CUDA schedules");
  const complete = assistant("assistant-1", "CUDA schedules kernels on the GPU.");

  const result = reconcileFinishedResponse(
    partial,
    [prompt, partial],
    [prompt, complete],
  );

  assert.deepEqual(result.messages, [prompt, complete]);
});

test("an older assistant cannot mask a genuinely empty new response", () => {
  const previousPrompt = user("user-1", "First question");
  const previousAnswer = assistant("assistant-1", "First answer");
  const currentPrompt = user("user-2", "Second question");
  const empty = assistant("assistant-2");

  const result = reconcileFinishedResponse(
    empty,
    [previousPrompt, previousAnswer, currentPrompt, empty],
    [previousPrompt, previousAnswer, currentPrompt, empty],
  );

  assert.equal(result.response, null);
});

function reasoned(
  id: string,
  reasoning: string,
  metadata: DialMessage["metadata"] = { startedAt: 1, durationMs: 9, finishReason: "stop", thinkingMs: 9 },
): DialMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: reasoning, state: "done" },
      { type: "text", text: "", state: "done" },
    ],
    metadata,
  };
}

test("an answer delivered on the reasoning channel becomes the answer", () => {
  const promoted = promoteReasoningAnswer(reasoned("a-1", "Paris is the capital of France."));
  assert.ok(promoted);
  assert.deepEqual(
    promoted.parts.map((part) => part.type),
    ["step-start", "text"],
  );
  assert.equal(
    promoted.parts[1].type === "text" && promoted.parts[1].text,
    "Paris is the capital of France.",
  );
  assert.equal(promoted.metadata?.answerInReasoning, true);
  assert.equal(promoted.metadata?.thinkingMs, undefined);
});

test("real text, a length cap, or a cut-off stream is never promoted", () => {
  const withText: DialMessage = {
    id: "a-2",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "thinking", state: "done" },
      { type: "text", text: "The answer.", state: "done" },
    ],
    metadata: { finishReason: "stop", startedAt: 1, durationMs: 2 },
  };
  assert.equal(promoteReasoningAnswer(withText), null);
  assert.equal(
    promoteReasoningAnswer(
      reasoned("a-3", "half a thought", { startedAt: 1, durationMs: 2, finishReason: "length" }),
    ),
    null,
  );
  assert.equal(
    promoteReasoningAnswer(reasoned("a-4", "cut off", { startedAt: 1 })),
    null,
  );
});

test("history sent to the model carries a promoted answer as text", () => {
  const [, answer] = messagesForTextModel([
    user("u-1", "Capital of France?"),
    reasoned("a-5", "Paris."),
  ]);
  assert.ok(answer.parts.some((part) => part.type === "text" && part.text === "Paris."));
  assert.ok(!answer.parts.some((part) => part.type === "reasoning"));
});

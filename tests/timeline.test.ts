import assert from "node:assert/strict";
import test from "node:test";
import type { DialMessage } from "../lib/messages.ts";
import { answerTextOf, buildTimeline, thoughtMs, type Block } from "../lib/timeline.ts";

type Part = DialMessage["parts"][number];

function turn(parts: Part[], metadata: DialMessage["metadata"] = {}): DialMessage {
  return { id: "a", role: "assistant", parts, metadata };
}

/** A compact picture of the timeline: one string per block. */
function shape(blocks: Block[]): string[] {
  return blocks.map((block) =>
    block.kind === "text"
      ? `text:${block.text.trim()}`
      : block.kind === "image"
        ? "image"
        : `activity:${block.steps
            .map((step) =>
              step.kind === "thought"
                ? `thought(${step.text.trim()})`
                : step.kind === "note"
                  ? `note(${step.text})`
                  : `search(${step.sources.length})`,
            )
            .join(",")}`,
  );
}

const source = (url: string): Part => ({ type: "source-url", sourceId: url, url, title: url });
const text = (value: string): Part => ({ type: "text", text: value, state: "done" });
const thought = (id: string, value: string, state: "done" | "streaming" = "done"): Part => ({
  type: "reasoning",
  id,
  text: value,
  state,
});

test("think, search, think, answer reads in that order", () => {
  const blocks = buildTimeline(
    turn([
      thought("r1", "Need current data."),
      source("https://a.example/1"),
      source("https://b.example/2"),
      thought("r2", "Sources agree."),
      text("The answer."),
    ]),
  );
  assert.deepEqual(shape(blocks), [
    "activity:thought(Need current data.),search(2),thought(Sources agree.)",
    "text:The answer.",
  ]);
});

test("remarks between searches fold into the work, in order", () => {
  // The shape DeepSeek actually streams with search on.
  const parts = [
    thought("r", "Wants two versions."),
    text("I'll look up the current versions of both runtimes."),
    source("https://nodejs.org/"),
    source("https://bun.com/"),
    thought("reasoning-resumed-1", "Node is 26.9."),
    text("Let me pin down the release date."),
    source("https://nodejs.org/en/blog"),
    thought("reasoning-resumed-2", "Released September 16."),
    text("**Node.js 26.9.0** is newer."),
  ];
  const expected = [
    "activity:thought(Wants two versions.),note(I'll look up the current versions of both runtimes.),search(2),thought(Node is 26.9.),note(Let me pin down the release date.),search(1),thought(Released September 16.)",
    "text:**Node.js 26.9.0** is newer.",
  ];
  assert.deepEqual(shape(buildTimeline(turn(parts))), expected);
  assert.deepEqual(shape(buildTimeline(turn(parts), { streaming: true })), expected);
  assert.equal(answerTextOf(buildTimeline(turn(parts))), "**Node.js 26.9.0** is newer.");
});

test("while streaming, text followed by more work is a remark, not the answer", () => {
  const blocks = buildTimeline(
    turn([thought("r", "plan", "done"), text("I'll search for that."), source("https://a.example/")]),
    { streaming: true },
  );
  assert.deepEqual(shape(blocks), ["activity:thought(plan),note(I'll search for that.),search(1)"]);
  assert.equal(answerTextOf(blocks), "");
});

test("while streaming, trailing text is the answer so far", () => {
  const blocks = buildTimeline(turn([thought("r", "plan"), text("Partial answ")]), { streaming: true });
  assert.deepEqual(shape(blocks), ["activity:thought(plan)", "text:Partial answ"]);
});

test("citations attached after a finished answer join the work above it", () => {
  const blocks = buildTimeline(
    turn([thought("r1", "plan"), text("Cited claim."), source("https://a.example/1"), source("https://a.example/1#fragment")]),
  );
  assert.deepEqual(shape(blocks), ["activity:thought(plan),search(1)", "text:Cited claim."]);
});

test("citations attached to the answer as it streams never split it", () => {
  const cite = (url: string, endIndex: number): Part => ({
    type: "source-url",
    sourceId: url,
    url,
    title: url,
    providerMetadata: { openrouter: { content: "", startIndex: 1, endIndex } },
  });
  const parts = [
    text("Node 26 is current"),
    cite("https://nodejs.org/", 18),
    text(" and Bun 1.4 trails it."),
    cite("https://bun.com/", 41),
  ];
  const expected = ["activity:search(2)", "text:Node 26 is current and Bun 1.4 trails it."];
  assert.deepEqual(shape(buildTimeline(turn(parts), { streaming: true })), expected);
  assert.deepEqual(shape(buildTimeline(turn(parts))), expected);
});

test("a search with no thinking is placed ahead of the answer", () => {
  const blocks = buildTimeline(turn([text("Answer."), source("https://a.example/1")]));
  assert.deepEqual(shape(blocks), ["activity:search(1)", "text:Answer."]);
});

test("adjacent thoughts merge into one step and keep both timings", () => {
  const blocks = buildTimeline(
    turn(
      [thought("r1", "first"), text("\n\n"), thought("reasoning-resumed-1", "second"), text("Answer")],
      { timings: { r1: [100, 900], "reasoning-resumed-1": [950, 3100] } },
    ),
  );
  assert.deepEqual(shape(blocks), ["activity:thought(first\n\nsecond)", "text:Answer"]);
  const activity = blocks[0];
  assert.equal(activity.kind, "activity");
  if (activity.kind !== "activity") return;
  const step = activity.steps[0];
  assert.equal(step.kind === "thought" && step.startMs, 100);
  assert.equal(step.kind === "thought" && step.endMs, 3100);
  assert.equal(thoughtMs(activity.steps), 3000);
});

test("legacy revived reasoning saved after its text is put back before it", () => {
  const blocks = buildTimeline(
    turn([thought("r1", "first"), text("\n\nThe answer."), thought("late-reasoning-1", "second")]),
  );
  assert.deepEqual(shape(blocks), ["activity:thought(first\n\nsecond)", "text:The answer."]);
});

test("empty encrypted reasoning and whitespace text leave nothing behind", () => {
  const blocks = buildTimeline(turn([thought("r1", ""), text("\n"), text("Hello")]));
  assert.deepEqual(shape(blocks), ["text:Hello"]);
});

test("a live thought keeps its step open", () => {
  const blocks = buildTimeline(turn([thought("r1", "", "streaming")], { timings: { r1: [40] } }), {
    streaming: true,
  });
  const activity = blocks[0];
  assert.equal(activity?.kind, "activity");
  if (activity?.kind !== "activity") return;
  const step = activity.steps[0];
  assert.equal(step.kind === "thought" && step.live, true);
  assert.equal(thoughtMs(activity.steps), undefined);
});

test("while searching, a short line after the work is held until it is clearly the answer", () => {
  const remark = "I'll look up the current versions of both runtimes.";
  const held = buildTimeline(turn([thought("r", "plan"), text(remark)]), {
    streaming: true,
    holdRemarks: true,
  });
  assert.deepEqual(shape(held), ["activity:thought(plan)"]);

  // More work behind it: it was a remark, and it lands in the work.
  const folded = buildTimeline(turn([thought("r", "plan"), text(remark), source("https://a.example/")]), {
    streaming: true,
    holdRemarks: true,
  });
  assert.deepEqual(shape(folded), [`activity:thought(plan),note(${remark}),search(1)`]);

  // It kept going: an answer, shown whole.
  const long = `${"Node.js 26.9.0 is newer than Bun 1.4.2 by release date, ".repeat(3)}and here is why.`;
  assert.deepEqual(shape(buildTimeline(turn([thought("r", "plan"), text(long)]), { streaming: true, holdRemarks: true })), [
    "activity:thought(plan)",
    `text:${long}`,
  ]);
  // A second line is never a remark; a trailing newline may still be one.
  assert.deepEqual(
    shape(buildTimeline(turn([thought("r", "plan"), text("Two:\n- Node")]), { streaming: true, holdRemarks: true })),
    ["activity:thought(plan)", "text:Two:\n- Node"],
  );
  assert.deepEqual(
    shape(buildTimeline(turn([thought("r", "plan"), text("Let me check.\n\n")]), { streaming: true, holdRemarks: true })),
    ["activity:thought(plan)"],
  );
  // Finished, or search off: nothing is held.
  assert.deepEqual(shape(buildTimeline(turn([thought("r", "plan"), text("Yes.")]), { holdRemarks: true })), [
    "activity:thought(plan)",
    "text:Yes.",
  ]);
  assert.deepEqual(shape(buildTimeline(turn([thought("r", "plan"), text("Yes.")]), { streaming: true })), [
    "activity:thought(plan)",
    "text:Yes.",
  ]);
  // With no work before it there is nothing for it to be a remark about.
  assert.deepEqual(shape(buildTimeline(turn([text("Hi")]), { streaming: true, holdRemarks: true })), ["text:Hi"]);
});

test("the first block of work keeps one key as it grows", () => {
  const keys = [
    [thought("r", "a", "streaming")],
    [text("Lead-in"), source("https://a.example/")],
    [thought("r", "a"), source("https://a.example/"), thought("r2", "b"), text("Answer")],
  ].map((parts) => buildTimeline(turn(parts as Part[]), { streaming: true }).find((b) => b.kind === "activity")?.key);
  assert.deepEqual(keys, ["work", "work", "work"]);
});

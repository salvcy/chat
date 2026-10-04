import assert from "node:assert/strict";
import test from "node:test";
import type { DialMessage } from "../lib/conversations";
import { applyFrame, diffTail, overlay, stripHeavy, tailOf, type LiveTail } from "../lib/live-frames.ts";

type Part = DialMessage["parts"][number];

const user = (id: string, text: string, extra: Part[] = []): DialMessage => ({
  id,
  role: "user",
  parts: [...extra, { type: "text", text }],
});
const assistant = (id: string, parts: Part[], metadata: DialMessage["metadata"] = {}): DialMessage => ({
  id,
  role: "assistant",
  parts,
  metadata,
});
const reasoning = (text: string, state: "streaming" | "done" = "streaming"): Part => ({
  type: "reasoning",
  text,
  state,
});
const said = (text: string, state: "streaming" | "done" = "streaming"): Part => ({
  type: "text",
  text,
  state,
});

/** Run a sequence of transcripts through the sender and receiver. */
function mirror(transcripts: DialMessage[][], base: number) {
  let sent: LiveTail | null = null;
  let held: LiveTail | null = null;
  const sizes: number[] = [];
  for (const transcript of transcripts) {
    const tail = tailOf(transcript, base);
    const body = diffTail(sent, tail);
    if (!body) continue;
    sizes.push(JSON.stringify(body).length);
    // The wire is JSON; nothing may depend on object identity across it.
    held = applyFrame(held, JSON.parse(JSON.stringify(body)));
    sent = tail;
  }
  return { held, sizes };
}

test("a reply streams across as small appends and arrives identical", () => {
  const history = [user("u0", "earlier"), assistant("a0", [said("earlier answer", "done")])];
  const question = user("u1", "what is newer?");
  const trace = "The user wants two versions compared. ".repeat(40);
  const steps: DialMessage[][] = [];
  for (let i = 1; i <= 40; i++) {
    steps.push([...history, question, assistant("a1", [reasoning(trace.slice(0, i * 38))], { startedAt: 1 })]);
  }
  const final = [
    ...history,
    question,
    assistant("a1", [reasoning(trace, "done"), said("Node is newer.", "done")], { startedAt: 1, durationMs: 900 }),
  ];
  steps.push(final);

  const { held, sizes } = mirror(steps, 2);
  assert.deepEqual(held, tailOf(final, 2));
  // After the keyframe, each frame carries roughly what arrived, not the whole message.
  assert.ok(Math.max(...sizes.slice(1)) < 300, `largest patch ${Math.max(...sizes.slice(1))} bytes`);
});

test("a regenerate or an edit on the streaming device is a new keyframe with an earlier base", () => {
  const before = [user("u1", "first"), assistant("a1", [said("one", "done")]), user("u2", "second")];
  const sent = tailOf(before, 2);
  const edited = tailOf([user("u1", "first, edited"), assistant("a9", [said("on")])], 0);
  const body = diffTail(sent, edited);
  assert.equal(body?.kind, "key");
  const shown = overlay(before, applyFrame(null, body!)!);
  assert.deepEqual(shown?.map((message) => message.id), ["u1", "a9"]);
});

test("nothing new means no frame", () => {
  const transcript = [user("u1", "hi"), assistant("a1", [said("hello")])];
  assert.equal(diffTail(tailOf(transcript, 0), tailOf(transcript, 0)), null);
});

test("a patch that does not fit what is held is refused, not misapplied", () => {
  assert.equal(applyFrame(null, { kind: "patch", patch: [{ m: 0, p: 0, append: "x" }] }), null);
  const held = tailOf([assistant("a1", [{ type: "source-url", sourceId: "s", url: "https://a.example" }])], 0);
  assert.equal(applyFrame(held, { kind: "patch", patch: [{ m: 0, p: 0, append: "x" }] }), null);
});

test("attachment bytes are not mirrored, and the receiver's own copy fills them back in", () => {
  const image: Part = { type: "file", mediaType: "image/png", url: `data:image/png;base64,${"A".repeat(5000)}` };
  const local = [user("u1", "look", [image])];
  const tail = tailOf(local, 0);
  assert.equal(JSON.stringify(tail).includes("AAAA"), false);
  assert.equal(stripHeavy(local[0]).parts[0].type, "file");
  const shown = overlay(local, tail);
  assert.equal((shown?.[0].parts[0] as { url: string }).url, image.url);
});

test("a tail that does not belong to the transcript held is not laid over it", () => {
  const tail = tailOf([user("u1", "a"), assistant("a1", []), user("u2", "b")], 2);
  assert.equal(overlay([user("u1", "a"), assistant("aX", [])], tail), null);
  assert.equal(overlay([user("u1", "a")], tail), null);
});

test("unchanged messages keep their identity on the receiving side", () => {
  const question = user("u1", "q");
  const first = [question, assistant("a1", [said("a")])];
  const second = [question, assistant("a1", [said("ab")])];
  const held = applyFrame(null, diffTail(null, tailOf(first, 0))!)!;
  const next = applyFrame(held, diffTail(tailOf(first, 0), tailOf(second, 0))!)!;
  assert.equal(next.messages[0], held.messages[0]);
  assert.notEqual(next.messages[1], held.messages[1]);
});

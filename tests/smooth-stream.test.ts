import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessageChunk } from "ai";
import { smoothStream } from "../lib/smooth-stream.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A source that yields chunks on a schedule: [delay before it, chunk]. */
function scripted(script: Array<[number, UIMessageChunk]>): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    async start(controller) {
      for (const [delay, chunk] of script) {
        if (delay) await sleep(delay);
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const out: Array<{ at: number; chunk: UIMessageChunk }> = [];
  const t0 = Date.now();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push({ at: Date.now() - t0, chunk: value });
  }
}

const fast = {
  tick: 5,
  minWindow: 40,
  maxWindow: 120,
  maxThinkingWindow: 120,
  busyWindow: 20,
  answerWindow: 30,
  minRate: 100,
};

/** When the last piece of a part's text went out. */
function doneAt(out: Array<{ at: number; chunk: UIMessageChunk }>, id: string) {
  return out.filter(({ chunk }) => "id" in chunk && chunk.id === id && chunk.type.endsWith("-delta")).at(-1)!.at;
}

function textOf(out: Array<{ chunk: UIMessageChunk }>, id: string) {
  return out
    .map(({ chunk }) => chunk)
    .filter((chunk) => (chunk.type === "text-delta" || chunk.type === "reasoning-delta") && chunk.id === id)
    .map((chunk) => (chunk as { delta: string }).delta)
    .join("");
}

test("nothing is lost, reordered or invented", async () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i} `).join("");
  const out = await collect(
    smoothStream(
      scripted([
        [0, { type: "start" }],
        [0, { type: "reasoning-start", id: "r" }],
        [0, { type: "reasoning-delta", id: "r", delta: words }],
        [10, { type: "source-url", sourceId: "s", url: "https://a.example" }],
        [0, { type: "reasoning-end", id: "r" }],
        [0, { type: "text-start", id: "t" }],
        ...words.split(" ").map((w): [number, UIMessageChunk] => [1, { type: "text-delta", id: "t", delta: `${w} ` }]),
        [0, { type: "text-end", id: "t" }],
        [0, { type: "finish" }],
      ]),
      fast,
    ),
  );
  assert.equal(textOf(out, "r"), words);
  assert.equal(textOf(out, "t"), words.split(" ").map((w) => `${w} `).join(""));
  const order = out
    .map(({ chunk }) => chunk.type)
    .filter((type) => type !== "text-delta" && type !== "reasoning-delta");
  assert.deepEqual(order, ["start", "reasoning-start", "source-url", "reasoning-end", "text-start", "text-end", "finish"]);
});

test("a burst after a long pause is revealed over time, not at once", async () => {
  const block = "x ".repeat(400);
  const out = await collect(
    smoothStream(
      scripted([
        [0, { type: "reasoning-start", id: "r" }],
        [0, { type: "reasoning-delta", id: "r", delta: "a " }],
        [150, { type: "reasoning-delta", id: "r", delta: block }],
        [0, { type: "reasoning-end", id: "r" }],
      ]),
      { ...fast, busyWindow: 1000 },
    ),
  );
  const deltas = out.filter(({ chunk }) => chunk.type === "reasoning-delta");
  assert.ok(deltas.length > 5, `released in ${deltas.length} pieces`);
  const first = deltas.find(({ chunk }) => (chunk as { delta: string }).delta.includes("x"));
  const span = deltas.at(-1)!.at - first!.at;
  assert.ok(span >= 60, `spread over ${span}ms`);
  assert.equal(textOf(out, "r"), `a ${block}`);
});

test("an abort flushes everything immediately", async () => {
  const out = await collect(
    smoothStream(
      scripted([
        [0, { type: "text-start", id: "t" }],
        [0, { type: "text-delta", id: "t", delta: "y ".repeat(2000) }],
        [0, { type: "abort" }],
      ]),
      { ...fast, minWindow: 2000, maxWindow: 2000 },
    ),
  );
  assert.ok(out.at(-1)!.at < 100, `finished at ${out.at(-1)!.at}ms`);
  assert.equal(out.at(-1)!.chunk.type, "abort");
});

test("tiny chunks arriving together become one update", async () => {
  const out = await collect(
    smoothStream(
      scripted([
        [0, { type: "text-start", id: "t" }],
        ...Array.from({ length: 50 }, (): [number, UIMessageChunk] => [0, { type: "text-delta", id: "t", delta: "ab " }]),
        [0, { type: "text-end", id: "t" }],
      ]),
      fast,
    ),
  );
  const deltas = out.filter(({ chunk }) => chunk.type === "text-delta");
  assert.ok(deltas.length < 20, `${deltas.length} updates for 50 chunks`);
  assert.equal(textOf(out, "t"), "ab ".repeat(50));
});

test("a surrogate pair is never split", async () => {
  const text = "😀".repeat(200);
  const out = await collect(
    smoothStream(
      scripted([
        [0, { type: "text-start", id: "t" }],
        [0, { type: "text-delta", id: "t", delta: "a" }],
        [100, { type: "text-delta", id: "t", delta: text }],
        [0, { type: "text-end", id: "t" }],
      ]),
      { ...fast, busyWindow: 500 },
    ),
  );
  for (const { chunk } of out) {
    if (chunk.type !== "text-delta") continue;
    const first = chunk.delta.charCodeAt(0);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "piece starts with a low surrogate");
  }
  assert.equal(textOf(out, "t"), `a${text}`);
});

test("results wait for the thinking in front of them; the answer does not", async () => {
  // The search loop's shape: silence, a round's thinking in one block, the
  // results a moment later, and eventually the answer.
  const block = "y ".repeat(300);
  const options = { ...fast, maxThinkingWindow: 400, answerWindow: 60 };

  const searched = await collect(
    smoothStream(
      scripted([
        [150, { type: "reasoning-start", id: "r" }],
        [0, { type: "reasoning-delta", id: "r", delta: block }],
        [5, { type: "source-url", sourceId: "s", url: "https://a.example" }],
        // The next round's thinking is seconds away.
        [500, { type: "finish" }],
      ]),
      options,
    ),
  );
  const source = searched.find(({ chunk }) => chunk.type === "source-url")!;
  const typed = doneAt(searched, "r") - searched.find(({ chunk }) => chunk.type === "reasoning-delta")!.at;
  assert.ok(typed >= 100, `a source behind it did not rush the thought (${typed}ms)`);
  assert.ok(source.at >= doneAt(searched, "r"), "the source still comes after the thought");

  const behind = (line: string) =>
    collect(
      smoothStream(
        scripted([
          [150, { type: "reasoning-start", id: "r" }],
          [0, { type: "reasoning-delta", id: "r", delta: block }],
          [0, { type: "reasoning-end", id: "r" }],
          [5, { type: "text-start", id: "t" }],
          [0, { type: "text-delta", id: "t", delta: line }],
          [500, { type: "finish" }],
        ]),
        options,
      ),
    );
  const waited = (out: Array<{ at: number; chunk: UIMessageChunk }>) =>
    out.find(({ chunk }) => chunk.type === "text-start")!.at -
    out.find(({ chunk }) => chunk.type === "reasoning-delta")!.at;

  // An answer catches the thinking up.
  const answer = "Node.js 26.9.0 is newer than Bun 1.4.2. ".repeat(4);
  const answered = await behind(answer);
  assert.ok(waited(answered) < 120, `the answer waited ${waited(answered)}ms behind the thinking`);
  assert.equal(textOf(answered, "r"), block);
  assert.equal(textOf(answered, "t"), answer);

  // A short line may be a remark, held off screen: the thinking keeps its pace.
  const remarked = await behind("Let me check that.");
  assert.ok(waited(remarked) >= 150, `a remark rushed the thinking (${waited(remarked)}ms)`);
});

test("a part's start chunk does not hide the silence before it", async () => {
  // orderStream announces each block of thinking a moment before its text;
  // the pause that matters is the one before the announcement.
  const out = await collect(
    smoothStream(
      scripted([
        [1000, { type: "reasoning-start", id: "r" }],
        [0, { type: "reasoning-delta", id: "r", delta: "z ".repeat(300) }],
        [0, { type: "reasoning-end", id: "r" }],
        [1000, { type: "finish" }],
      ]),
      { ...fast, maxThinkingWindow: 2000, busyWindow: 20 },
    ),
  );
  const deltas = out.filter(({ chunk }) => chunk.type === "reasoning-delta");
  const span = deltas.at(-1)!.at - deltas[0].at;
  assert.ok(span >= 400, `typed out over ${span}ms`);
});

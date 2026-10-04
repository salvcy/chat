import assert from "node:assert/strict";
import test from "node:test";
import {
  isStreamingRollback,
  reuseUploadedBlobReferences,
} from "../lib/message-sync.ts";

test("an upload memo never replaces newer streamed text or reasoning", () => {
  const current = [
    { type: "reasoning", text: "the complete chain of thought" },
    { type: "text", text: "the complete answer" },
    {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,current-bytes",
      providerMetadata: { dial: { imageReference: true } },
    },
  ];
  const firstCheckpoint = [
    { type: "reasoning", text: "the partial" },
    { type: "text", text: "the partial" },
    {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,current-bytes",
      providerMetadata: {
        dial: {
          imageReference: true,
          blobId: "thread/message.f.2.0",
          blobUrl: "https://blobs.example/thread/message.f.2.0",
        },
      },
    },
  ];

  const merged = reuseUploadedBlobReferences(current, firstCheckpoint);

  assert.equal(merged[0].text, "the complete chain of thought");
  assert.equal(merged[1].text, "the complete answer");
  assert.deepEqual(merged[2].providerMetadata, firstCheckpoint[2].providerMetadata);
});

test("generated-image references are reused without replacing current data", () => {
  const current = [
    {
      type: "data-image",
      data: {
        status: "complete",
        prompt: "new prompt metadata",
        images: [{ url: "data:image/png;base64,pixels", mediaType: "image/png" }],
      },
    },
  ];
  const cached = [
    {
      type: "data-image",
      data: {
        status: "generating",
        prompt: "old prompt metadata",
        images: [
          {
            url: "data:image/png;base64,pixels",
            mediaType: "image/png",
            blobId: "thread/message.g.0.0",
          },
        ],
      },
    },
  ];

  const [merged] = reuseUploadedBlobReferences(current, cached);

  assert.equal(merged.data.status, "complete");
  assert.equal(merged.data.prompt, "new prompt metadata");
  assert.equal(
    (merged.data.images[0] as Record<string, unknown>).blobId,
    "thread/message.g.0.0",
  );
});

test("a strict remote prefix is rejected but a genuine edit is accepted", () => {
  const local = [
    { id: "assistant-1", parts: [{ type: "text", text: "a complete answer" }] },
  ];

  assert.equal(
    isStreamingRollback(local, [
      { id: "assistant-1", parts: [{ type: "text", text: "a complete" }] },
    ]),
    true,
  );
  assert.equal(
    isStreamingRollback(local, [
      { id: "assistant-1", parts: [{ type: "text", text: "an edited answer" }] },
    ]),
    false,
  );
});

"use client";

import { OPENROUTER_API, authHeaders } from "./openrouter-client";
import { DEFAULT_IMAGE_MODEL, type GeneratedImageAsset } from "./types";

/**
 * The `@image` tool, executed against OpenRouter's dedicated Images API.
 *
 * This replaces `/api/image`. Going direct matters more here than anywhere
 * else in the app: a generated PNG is measured in megabytes, and the old
 * path uploaded it into our function's memory only to hand it straight back
 * to the browser that asked for it. Now the bytes travel once.
 *
 * Images come back as data URLs so this local-first app can persist them in
 * IndexedDB. That is a deliberate step-1 choice with a known ceiling — once
 * accounts exist these belong in object storage as encrypted blobs, with
 * only an id in the message.
 */

/** IndexedDB has to hold whatever comes back; refuse the truly enormous. */
const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;

type OpenRouterImageResponse = {
  created?: number;
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  error?: { message?: string } | string;
};

export type ImageResult = {
  model: string;
  images: GeneratedImageAsset[];
  durationMs: number;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};

/** Decoded byte count of a base64 payload, without allocating it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function upstreamMessage(
  payload: OpenRouterImageResponse,
  status: number,
): string {
  const message =
    typeof payload.error === "string" ? payload.error : payload.error?.message;
  return message || `OpenRouter image generation returned ${status}`;
}

export async function generateImage({
  key,
  model,
  prompt,
  references,
  signal,
}: {
  key: string;
  /**
   * The selected chat model, when its catalog output modalities include
   * `image`. Undefined falls back to the configured default — a *vision*
   * model cannot stand in here, because vision is image input and this
   * needs image output.
   */
  model?: string;
  prompt: string;
  references?: GeneratedImageAsset[];
  signal?: AbortSignal;
}): Promise<ImageResult> {
  const target = model ?? DEFAULT_IMAGE_MODEL;
  const startedAt = Date.now();

  const response = await fetch(`${OPENROUTER_API}/images`, {
    method: "POST",
    headers: { ...authHeaders(key), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: target,
      prompt,
      n: 1,
      ...((references?.length ?? 0) > 0
        ? {
            input_references: references?.map((reference) => ({
              type: "image_url",
              image_url: { url: reference.url },
            })),
          }
        : {}),
    }),
    signal,
  });

  let payload: OpenRouterImageResponse;
  try {
    payload = (await response.json()) as OpenRouterImageResponse;
  } catch {
    throw new Error("OpenRouter returned an invalid image response");
  }

  if (!response.ok || payload.error) {
    throw new Error(upstreamMessage(payload, response.status));
  }

  const images = (payload.data ?? []).flatMap<GeneratedImageAsset>((item) => {
    const base64 = item.b64_json;
    if (!base64) return [];
    if (decodedBytes(base64) > MAX_GENERATED_IMAGE_BYTES) return [];
    const mediaType = item.media_type?.startsWith("image/")
      ? item.media_type
      : "image/png";
    return [{ url: `data:${mediaType};base64,${base64}`, mediaType }];
  });

  if (images.length === 0) {
    throw new Error(
      "OpenRouter returned no image, or the generated file exceeded 10 MB",
    );
  }

  return {
    model: target,
    images,
    durationMs: Date.now() - startedAt,
    usage: {
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      totalTokens: payload.usage?.total_tokens,
      costUsd: payload.usage?.cost,
    },
  };
}

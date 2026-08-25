import { imageRequestSchema } from "@/lib/schema";
import { DEFAULT_IMAGE_MODEL, MODEL_ID_PATTERN } from "@/lib/types";

/** Image generation can legitimately take longer than a text response. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
const MAX_IMAGE_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

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

function jsonError(message: string, status = 400) {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function upstreamError(payload: OpenRouterImageResponse, status: number) {
  const message =
    typeof payload.error === "string"
      ? payload.error
      : payload.error?.message;
  return message || `OpenRouter image generation returned ${status}`;
}

/**
 * POST /api/image — deterministic execution for the composer's @image tool.
 *
 * This uses OpenRouter's dedicated Images API instead of spending a second
 * language-model turn deciding whether the user really meant to make an
 * image. Image-output models selected in the chat are honored; the configured
 * default is only a fallback. Results include measured upstream cost and are
 * returned as data URLs so this local-first app can persist them in IndexedDB.
 */
export async function POST(req: Request) {
  const declaredSize = Number(req.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_IMAGE_REQUEST_BYTES) {
    return jsonError("request body is too large", 413);
  }

  let raw: unknown;
  try {
    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > MAX_IMAGE_REQUEST_BYTES) {
      return jsonError("request body is too large", 413);
    }
    raw = JSON.parse(body);
  } catch {
    return jsonError("request body was not valid JSON");
  }

  const parsed = imageRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(
      `${issue.path.join(".") || "body"}: ${issue.message.toLowerCase()}`,
    );
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return jsonError(
      "OPENROUTER_API_KEY is not set — add it to .env.local",
      500,
    );
  }

  const model =
    parsed.data.model ??
    (process.env.OPENROUTER_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL);
  if (!MODEL_ID_PATTERN.test(model)) {
    return jsonError(
      "OPENROUTER_IMAGE_MODEL must use a provider/model-slug",
      500,
    );
  }

  for (const reference of parsed.data.references ?? []) {
    const comma = reference.url.indexOf(",");
    if (comma < 0 || !reference.url.slice(0, comma).includes(";base64")) {
      return jsonError("references must be base64 image data URLs");
    }
    if (decodedBytes(reference.url.slice(comma + 1)) > MAX_REFERENCE_IMAGE_BYTES) {
      return jsonError("each reference image must be smaller than 8 MB", 413);
    }
  }

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.OPENROUTER_APP_URL ?? "http://localhost:3000",
        "X-Title": "Chat",
      },
      body: JSON.stringify({
        model,
        prompt: parsed.data.prompt,
        n: 1,
        ...((parsed.data.references?.length ?? 0) > 0
          ? {
              input_references: parsed.data.references?.map((reference) => ({
                type: "image_url",
                image_url: { url: reference.url },
              })),
            }
          : {}),
      }),
      signal: req.signal,
    });
  } catch (error) {
    if (req.signal.aborted) return jsonError("image generation stopped", 499);
    return jsonError(
      error instanceof Error ? error.message : "image generation failed",
      502,
    );
  }

  let payload: OpenRouterImageResponse;
  try {
    payload = (await upstream.json()) as OpenRouterImageResponse;
  } catch {
    return jsonError("OpenRouter returned an invalid image response", 502);
  }

  if (!upstream.ok || payload.error) {
    return jsonError(upstreamError(payload, upstream.status), upstream.status);
  }

  const images = (payload.data ?? []).flatMap((item) => {
    const base64 = item.b64_json;
    if (!base64) return [];
    if (decodedBytes(base64) > MAX_GENERATED_IMAGE_BYTES) return [];
    const mediaType = item.media_type?.startsWith("image/")
      ? item.media_type
      : "image/png";
    return [{ url: `data:${mediaType};base64,${base64}`, mediaType }];
  });

  if (images.length === 0) {
    return jsonError(
      "OpenRouter returned no image, or the generated file exceeded 10 MB",
      502,
    );
  }

  return Response.json(
    {
      model,
      images,
      created: payload.created,
      durationMs: Date.now() - startedAt,
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens,
        costUsd: payload.usage?.cost,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

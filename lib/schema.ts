import { z } from "zod";
import {
  MODEL_ID_PATTERN,
  REASONING_EFFORTS,
  type GeneratedImageData,
  type RequestStatusData,
  type ReasoningEffort,
} from "./types";

/**
 * Request validation for the chat route. The previous version hand-rolled
 * `typeof x === "string"` checks and silently coerced anything unexpected;
 * this makes the contract explicit and gives the client a real 400 with a
 * reason instead of a mystery 500 deeper in the SDK.
 */

/** Cap the system prompt so a runaway client can't blow up the context. */
const MAX_SYSTEM_CHARS = 8000;
const MAX_MESSAGES = 200;
const MAX_IMAGE_PROMPT_CHARS = 4000;

export const reasoningEffortSchema = z.enum(
  REASONING_EFFORTS as readonly [ReasoningEffort, ...ReasoningEffort[]],
);

/** Metadata is persisted by older builds, so all fields stay optional. */
export const dialMetadataSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  startedAt: z.number().optional(),
  ttftMs: z.number().nonnegative().optional(),
  thinkingMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  finishReason: z.string().optional(),
  effort: reasoningEffortSchema.optional(),
  search: z.boolean().optional(),
});

export const chatRequestSchema = z.object({
  /** UIMessages from useChat. Validated structurally by the SDK downstream. */
  messages: z.array(z.unknown()).min(1).max(MAX_MESSAGES),
  model: z
    .string()
    .regex(MODEL_ID_PATTERN, "expected provider/model-slug")
    .optional(),
  reasoning: reasoningEffortSchema.optional(),
  search: z.boolean().optional(),
  system: z.string().max(MAX_SYSTEM_CHARS).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const imageRequestSchema = z.object({
  model: z
    .string()
    .regex(MODEL_ID_PATTERN, "expected provider/model-slug")
    .optional(),
  prompt: z.string().trim().min(1).max(MAX_IMAGE_PROMPT_CHARS),
  references: z
    .array(
      z.object({
        url: z.string().startsWith("data:image/"),
        mediaType: z.string().startsWith("image/"),
      }),
    )
    .max(4)
    .optional(),
});

/** Generated image parts are persisted, exported, and reloaded from Dexie. */
export const generatedImageDataSchema: z.ZodType<GeneratedImageData> = z.object({
  status: z.enum(["generating", "complete", "error"]),
  prompt: z.string().max(MAX_IMAGE_PROMPT_CHARS),
  model: z.string(),
  images: z
    .array(
      z.object({
        url: z.string(),
        mediaType: z.string().startsWith("image/"),
      }),
    )
    .max(4),
  startedAt: z.number(),
  durationMs: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});

export const requestStatusDataSchema: z.ZodType<RequestStatusData> = z.object({
  kind: z.enum(["interrupted", "empty"]),
  at: z.number(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const titleRequestSchema = z.object({
  /** The opening exchange — enough to name the thread. */
  prompt: z.string().min(1).max(2000),
  reply: z.string().max(2000).optional(),
});

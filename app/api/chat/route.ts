import {
  convertToModelMessages,
  streamText,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { DEFAULT_MODEL, openrouter } from "@/lib/openrouter";
import { REASONING_EFFORTS, type ReasoningEffort } from "@/lib/types";
import type { OpenRouterProviderOptions } from "@openrouter/ai-sdk-provider";

/** provider/slug, optionally with :variant (e.g. anthropic/claude-sonnet-4.6) */
const MODEL_ID_PATTERN = /^[\w.-]+\/[\w:.-]{1,120}$/;

type ChatBody = {
  messages: UIMessage[];
  model?: unknown;
  reasoning?: unknown; // ReasoningEffort
  search?: unknown; // boolean
};

/** Strip any client-sent system messages — a system prompt is set
 *  server-side (Phase 4's per-conversation prompt), never trusted raw. */
function withoutSystem(messages: UIMessage[]): UIMessage[] {
  return messages.filter((m) => m.role !== "system");
}

export async function POST(req: Request) {
  const body = (await req.json()) as ChatBody;
  const { messages } = body;

  const model =
    typeof body.model === "string" && MODEL_ID_PATTERN.test(body.model)
      ? body.model
      : DEFAULT_MODEL;

  const reasoning: ReasoningEffort = REASONING_EFFORTS.includes(
    body.reasoning as ReasoningEffort,
  )
    ? (body.reasoning as ReasoningEffort)
    : "off";

  const search = body.search === true;

  const modelMessages: ModelMessage[] = await convertToModelMessages(
    withoutSystem(messages),
  );

  // Reasoning: OpenRouter's unified param; surfaced as `reasoning` parts.
  // Web search: the openrouter:web_search server tool (model decides when);
  // sources arrive as `source-url` parts. Typed so a bad key fails to build.
  const openrouterOpts: OpenRouterProviderOptions = {
    ...(reasoning !== "off" && {
      reasoning: { enabled: true, effort: reasoning },
    }),
  };

  const result = streamText({
    model: openrouter(model),
    messages: modelMessages,
    tools:
      search === true
        ? { web_search: openrouter.tools.webSearch({}) }
        : undefined,
    providerOptions: { openrouter: openrouterOpts },
  });

  return result.toUIMessageStreamResponse({
    sendSources: true,
    // Surface the upstream error message in the stream (instead of a bare
    // 200) so the client can show e.g. a data-policy-restricted model.
    onError: (err) =>
      err instanceof Error ? err.message : "an error occurred",
  });
}

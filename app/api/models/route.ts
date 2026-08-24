import type { OpenRouterModel } from "@/lib/types";

/**
 * GET /api/models — the live OpenRouter model catalog, trimmed to what the
 * switcher needs. Fetched server-side and cached for 1 hour via the
 * upstream fetch cache; the key never reaches the client.
 */
export async function GET() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return Response.json(
        { error: `OpenRouter catalog returned ${res.status}` },
        { status: 502 },
      );
    }

    const { data } = (await res.json()) as {
      data: Array<{
        id: string;
        name: string;
        context_length?: number | null;
        top_provider?: { context_length?: number | null } | null;
        pricing?: { prompt?: string; completion?: string } | null;
      }>;
    };

    const models: OpenRouterModel[] = data.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
      promptPrice: m.pricing?.prompt ?? null,
      completionPrice: m.pricing?.completion ?? null,
    }));

    return Response.json({ models });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "catalog fetch failed" },
      { status: 502 },
    );
  }
}

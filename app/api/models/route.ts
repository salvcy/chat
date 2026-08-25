import { CatalogError, fetchCatalog } from "@/lib/catalog";

/**
 * GET /api/models — the live OpenRouter catalog, normalized.
 *
 * This is deliberately richer than "what the switcher renders": it carries
 * each model's capability surface (vision input / image output / tools /
 * reasoning efforts) so
 * the composer can offer exactly the controls a model will honour. Cached
 * upstream for an hour; the key never reaches the client.
 */
export async function GET() {
  try {
    const models = await fetchCatalog();
    return Response.json(
      { models, fetchedAt: Date.now() },
      // Let the browser reuse it for the session without re-hitting us.
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (err) {
    const status = err instanceof CatalogError ? err.status : 502;
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "model catalog fetch failed",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * GET /api/key — the credit gauge.
 *
 * OpenRouter reports spend and remaining allowance for the key itself. It's
 * the one number this app can show that isn't per-message, and it belongs in
 * the same mono readout language as tok/s and cost. Never returns the key.
 */
type KeyResponse = {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
    limit_remaining?: number | null;
    is_free_tier?: boolean;
  };
};

export async function GET() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is not set" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });

    if (!res.ok) {
      return Response.json(
        { error: `key lookup returned ${res.status}` },
        {
          status: res.status === 401 ? 401 : 502,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const { data } = (await res.json()) as KeyResponse;
    return Response.json(
      {
        usage: data?.usage ?? null,
        limit: data?.limit ?? null,
        remaining: data?.limit_remaining ?? null,
        freeTier: data?.is_free_tier ?? false,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "key lookup failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

"use client";

import { OPENROUTER_API, authHeaders } from "./openrouter-client";

/**
 * The credit gauge — spend and remaining allowance for the connected key.
 *
 * This replaces `/api/key`. The endpoint reports on whichever key is
 * presented, so with a per-user key the reading is now genuinely *the
 * user's* balance rather than the operator's.
 */

export type KeyStatus = {
  label: string | null;
  usage: number | null;
  limit: number | null;
  remaining: number | null;
  freeTier: boolean;
};

type KeyResponse = {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
    limit_remaining?: number | null;
    is_free_tier?: boolean;
  };
};

export class KeyRejectedError extends Error {
  constructor() {
    super("OpenRouter rejected this key.");
    this.name = "KeyRejectedError";
  }
}

export async function fetchKeyStatus(
  key: string,
  signal?: AbortSignal,
): Promise<KeyStatus> {
  const res = await fetch(`${OPENROUTER_API}/key`, {
    headers: authHeaders(key),
    signal,
  });

  if (res.status === 401) throw new KeyRejectedError();
  if (!res.ok) throw new Error(`key lookup returned ${res.status}`);

  const { data } = (await res.json()) as KeyResponse;
  return {
    label: data?.label ?? null,
    usage: data?.usage ?? null,
    limit: data?.limit ?? null,
    remaining: data?.limit_remaining ?? null,
    freeTier: data?.is_free_tier ?? false,
  };
}

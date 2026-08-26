import { createAuth } from "./auth";
import type { Env } from "./env";
export { SyncHub } from "./live";

/**
 * The API.
 *
 * Six surfaces, all under `/v1/` on the same origin as the app:
 *
 *   /v1/auth/*   Better Auth — email+password, Google, sessions
 *   /v1/sync     conversation records, by cursor
 *   /v1/state    the user's settings blob and encryption mode
 *   /v1/blobs/*  client-encrypted image objects in R2
 *   /v1/live     hibernating realtime invalidation socket
 *   /v1/me       delete everything
 *
 * ## The CPU budget is the design constraint
 *
 * Workers bill CPU and the free tier allows 10ms per request. Two decisions
 * follow, and both are load-bearing rather than micro-optimisation:
 *
 *  - Password stretching happens in the browser (see `auth.ts`), so this
 *    Worker never runs a slow hash.
 *  - Sessions are read from a signed cookie for five minutes at a time
 *    rather than from D1 on every call.
 *
 * ## Trust boundary
 *
 * `payload` and `settings` are opaque. The sync endpoints move bytes and
 * never parse them, which is what lets one deployment serve both
 * end-to-end-encrypted accounts and server-readable ones with no branching.
 */

/**
 * Must stay strictly greater than MAX_PUSH_RECORDS.
 *
 * `pull` pages by `rev > since` and the client advances its cursor to the
 * last row's revision, so every record sharing a revision has to fit in one
 * page — anything spilling past the limit would be skipped for good. One
 * push allocates exactly one revision and carries at most MAX_PUSH_RECORDS
 * records, so that is the size of the largest possible group, and the gap
 * between the two numbers is the safety margin.
 */
const PAGE_SIZE = 250;
const MAX_PAYLOAD_CHARS = 128 * 1024;
const MAX_SETTINGS_CHARS = 64 * 1024;
const MAX_PUSH_RECORDS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 11 * 1024 * 1024;
/**
 * `g` generated image · `f` user attachment · `p` a spilled record payload
 * that did not fit in D1. All three share the record's id as their prefix,
 * which is what lets a deletion clear them without reading anything.
 */
const BLOB_ID = /^[A-Za-z0-9_-]{1,96}\.(?:g|f|p)\.\d{1,4}\.\d{1,4}$/;

type RecordRow = {
  id: string;
  rev: number;
  deleted: number;
  payload: string | null;
};
type StateRow = { rev: number; encryption: string; settings: string | null };

const ENCRYPTION_MODES = new Set(["none", "password", "passphrase"]);

/* ------------------------------- helpers ------------------------------- */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error("request body is too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body was not valid JSON");
  }
}

/**
 * Every user gets a state row on first contact rather than at signup, so a
 * Google account created through the OAuth callback is not a special case.
 *
 * Returns null when the user no longer exists, which the router turns into a
 * 401. That is not a theoretical branch: sessions are read from a signed
 * cookie for five minutes at a time, so a cookie minted before an account
 * was deleted stays cryptographically valid after it. Without this check the
 * insert below hit a foreign-key violation and the request 500'd — a deleted
 * account failing *open* with a server error instead of failing closed.
 */
async function loadState(
  env: Env,
  userId: string,
): Promise<StateRow | null> {
  const existing = await env.DB.prepare(
    `SELECT rev, encryption, settings FROM user_state WHERE user_id = ?`,
  )
    .bind(userId)
    .first<StateRow>();
  if (existing) return existing;

  try {
    // The foreign key is the existence check, so the happy path costs
    // nothing extra — an established user never reaches this statement.
    await env.DB.prepare(
      `INSERT INTO user_state (user_id, rev, encryption, settings, updated_at)
       VALUES (?, 0, 'none', NULL, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(userId, Date.now())
      .run();
  } catch {
    return null;
  }
  return { rev: 0, encryption: "none", settings: null };
}

/* ------------------------------ endpoints ------------------------------ */

async function pull(
  request: Request,
  env: Env,
  userId: string,
  state: StateRow,
): Promise<Response> {
  const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
  if (!Number.isInteger(since) || since < 0) {
    return fail("since must be a non-negative integer", 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, rev, deleted, payload
       FROM record
      WHERE user_id = ? AND rev > ?
      ORDER BY rev
      LIMIT ?`,
  )
    .bind(userId, since, PAGE_SIZE)
    .all<RecordRow>();

  const records = results.map((row) => ({
    id: row.id,
    rev: row.rev,
    deleted: row.deleted === 1,
    payload: row.payload,
  }));

  return json({
    records,
    rev: state.rev,
    hasMore: records.length === PAGE_SIZE,
  });
}

async function push(
  request: Request,
  env: Env,
  userId: string,
  state: StateRow,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = (await readJson(request)) as {
    records?: unknown;
    client?: unknown;
  };
  if (!Array.isArray(body.records)) return fail("records must be an array", 400);
  if (body.records.length === 0) return json({ rev: state.rev, applied: 0 });
  if (body.records.length > MAX_PUSH_RECORDS) {
    return fail(`push at most ${MAX_PUSH_RECORDS} records at a time`, 400);
  }

  const incoming: { id: string; payload: string | null; deleted: boolean }[] = [];

  for (const raw of body.records) {
    const item = raw as { id?: unknown; payload?: unknown; deleted?: unknown };
    if (
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 128
    ) {
      return fail("each record needs a string id", 400);
    }
    if (item.deleted === true) {
      incoming.push({ id: item.id, payload: null, deleted: true });
      continue;
    }
    if (typeof item.payload !== "string" || item.payload.length === 0) {
      return fail("each live record needs a payload", 400);
    }
    if (item.payload.length > MAX_PAYLOAD_CHARS) {
      return fail("a record exceeded the 128KB payload limit", 413);
    }
    incoming.push({ id: item.id, payload: item.payload, deleted: false });
  }

  /*
   * Allocate the revision in the database rather than deriving it from the
   * row read at the top of the request.
   *
   * Two devices pushing at once both read the same `state.rev` and both
   * wrote rev+1 — and that was silent data loss, not just a duplicate
   * number: a third device pulling between the two writes advanced its
   * cursor past the shared revision and never asked for the second batch
   * again. Realtime is what made two devices online at once the normal
   * case, so this went from theoretical to routine. A single
   * `UPDATE … RETURNING` is atomic, so concurrent pushes get distinct
   * revisions and each one's records stay reachable.
   */
  const allocated = await env.DB.prepare(
    `UPDATE user_state SET rev = rev + 1, updated_at = ?
      WHERE user_id = ?
      RETURNING rev`,
  )
    .bind(Date.now(), userId)
    .first<{ rev: number }>();
  if (!allocated) return fail("unauthorized", 401);
  const rev = allocated.rev;

  await env.DB.batch([
    ...incoming.map((record) =>
      env.DB.prepare(
        `INSERT INTO record (user_id, id, rev, deleted, payload)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
              rev = excluded.rev,
              deleted = excluded.deleted,
              payload = excluded.payload`,
      ).bind(userId, record.id, rev, record.deleted ? 1 : 0, record.payload),
    ),
  ]);

  // A revision is only a wake-up hint. Devices still authenticate and pull
  // opaque rows through D1, so a dropped socket message cannot lose data.
  // The pushing device is excluded by its own connection id: it already has
  // this revision in the response below, and waking it would only make it
  // push again.
  ctx.waitUntil(
    notifyLive(
      env,
      userId,
      rev,
      typeof body.client === "string" && body.client.length <= 64
        ? body.client
        : null,
    ),
  );

  const deletedIds = incoming
    .filter((record) => record.deleted)
    .map((record) => record.id);
  if (deletedIds.length > 0) {
    ctx.waitUntil(
      Promise.all(
        deletedIds.map((recordId) =>
          deleteRecordBlobs(env.BLOBS, userId, recordId),
        ),
      ).then(() => undefined),
    );
  }

  return json({ rev, applied: incoming.length });
}

/* ----------------------------- R2 blobs ------------------------------- */

function blobKey(userId: string, blobId: string): string {
  return `${userId}/${blobId}`;
}

function publicBlobUrl(
  env: Env,
  userId: string,
  blobId: string,
  encrypted: boolean,
): string | null {
  if (!encrypted || !env.BLOB_PUBLIC_ORIGIN) return null;
  const origin = env.BLOB_PUBLIC_ORIGIN.replace(/\/+$/, "");
  return `${origin}/${encodeURIComponent(userId)}/${encodeURIComponent(blobId)}`;
}

async function putBlob(
  request: Request,
  env: Env,
  userId: string,
  blobId: string,
  state: StateRow,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BLOB_BYTES) return fail("image exceeded 11 MB", 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return fail("image was empty", 400);
  if (bytes.byteLength > MAX_BLOB_BYTES) {
    return fail("image exceeded 11 MB", 413);
  }

  const object = await env.BLOBS.put(blobKey(userId, blobId), bytes, {
    httpMetadata: {
      contentType: "application/octet-stream",
      // A retry can replace a deterministic key, so stale ciphertext must
      // never be cached under the custom-domain URL.
      cacheControl: "no-store",
    },
  });
  return json({
    id: blobId,
    etag: object.httpEtag,
    url: publicBlobUrl(env, userId, blobId, state.encryption !== "none"),
  });
}

async function getBlob(
  env: Env,
  userId: string,
  blobId: string,
): Promise<Response> {
  const object = await env.BLOBS.get(blobKey(userId, blobId));
  if (!object) return fail("image not found", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function deleteBlob(
  env: Env,
  userId: string,
  blobId: string,
): Promise<Response> {
  await env.BLOBS.delete(blobKey(userId, blobId));
  return new Response(null, { status: 204 });
}

async function deleteBlobPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<void> {
  // Restart at the prefix after each delete. Continuing an opaque cursor
  // through a collection we just mutated can skip keys on some object stores.
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) return;
    await bucket.delete(page.objects.map((object) => object.key));
  }
}

async function deleteRecordBlobs(
  bucket: R2Bucket,
  userId: string,
  recordId: string,
): Promise<void> {
  let prefix = recordId;
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(recordId)) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recordId)),
    );
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    prefix = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  await deleteBlobPrefix(bucket, `${userId}/${prefix}.`);
}

async function notifyLive(
  env: Env,
  userId: string,
  rev: number,
  exclude: string | null,
): Promise<void> {
  const stub = env.LIVE.get(env.LIVE.idFromName(userId));
  await stub.fetch("https://live.internal/notify", {
    method: "POST",
    body: JSON.stringify({ rev, exclude }),
  });
}

/** Connection ids only ever come back to us as a tag to skip. */
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function connectLive(
  request: Request,
  env: Env,
  userId: string,
  rev: number,
  connection: string | null,
): Promise<Response> {
  const stub = env.LIVE.get(env.LIVE.idFromName(userId));
  const headers = new Headers();
  const upgrade = request.headers.get("Upgrade");
  if (upgrade) headers.set("Upgrade", upgrade);
  const query = connection ? `&c=${connection}` : "";
  return stub.fetch(`https://live.internal/connect?rev=${rev}${query}`, {
    headers,
  });
}

/** GET /v1/state — settings blob + encryption mode. */
function readState(state: StateRow): Response {
  return json({
    rev: state.rev,
    encryption: state.encryption,
    settings: state.settings,
  });
}

/**
 * PUT /v1/state — replace the settings blob.
 *
 * `encryption` can move away from 'none' but never back to it. Going the
 * other way would mean the client had decrypted everything and rewritten it
 * in the clear — a migration, not a settings change — and accepting it
 * silently would be a one-request way to downgrade an account's protection.
 */
async function writeState(
  request: Request,
  env: Env,
  userId: string,
  state: StateRow,
): Promise<Response> {
  const body = (await readJson(request)) as {
    settings?: unknown;
    encryption?: unknown;
  };

  if (typeof body.settings !== "string" && body.settings !== null) {
    return fail("settings must be a string or null", 400);
  }
  if (
    typeof body.settings === "string" &&
    body.settings.length > MAX_SETTINGS_CHARS
  ) {
    return fail("settings exceeded the 64KB limit", 413);
  }

  let encryption = state.encryption;
  if (body.encryption !== undefined) {
    if (
      typeof body.encryption !== "string" ||
      !ENCRYPTION_MODES.has(body.encryption)
    ) {
      return fail("encryption must be none, password, or passphrase", 400);
    }
    if (state.encryption !== "none" && body.encryption === "none") {
      return fail(
        "turning encryption off is a migration, not a settings change",
        409,
      );
    }
    encryption = body.encryption;
  }

  await env.DB.prepare(
    `UPDATE user_state SET settings = ?, encryption = ?, updated_at = ?
      WHERE user_id = ?`,
  )
    .bind(body.settings, encryption, Date.now(), userId)
    .run();

  return json({ ok: true, encryption });
}

/**
 * DELETE /v1/me — erase the account and everything attached to it.
 *
 * Present from day one deliberately. This app now stores a name, a date of
 * birth, an email and the full text of people's conversations; a delete path
 * that actually works is the minimum that justifies collecting any of it.
 * The foreign keys cascade, so one statement clears sessions, OAuth links,
 * settings and records together.
 */
async function deleteMe(env: Env, userId: string): Promise<Response> {
  // R2 has no foreign keys. Clear the user's prefix before removing the D1
  // identity so an account deletion leaves no orphaned ciphertext behind.
  await deleteBlobPrefix(env.BLOBS, `${userId}/`);
  await env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(userId).run();

  // Expire this device's cookies in the same response. The signed session
  // cookie is valid until it expires on its own, so without this the client
  // that just deleted its account would keep presenting a credential for an
  // account that no longer exists.
  const response = json({ deleted: true });
  for (const name of [
    "better-auth.session_token",
    "better-auth.session_data",
    "__Secure-better-auth.session_token",
    "__Secure-better-auth.session_data",
  ]) {
    response.headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  }
  return response;
}

/* -------------------------------- router ------------------------------- */

/**
 * One Better Auth instance per isolate rather than per request.
 *
 * Bindings do not exist at module scope, so the instance cannot be built
 * eagerly — but it can be built on the first request and reused by every
 * subsequent one the isolate serves. Constructing it is not free (option
 * validation, adapter and plugin wiring), and paying that on every call was
 * measurable: it was the difference between signup fitting in the Workers
 * free-tier CPU budget and overshooting it several times over.
 *
 * Keyed on origin as well as env so a preview hostname can never be served
 * an instance whose baseURL points at production.
 */
let cachedAuth: { origin: string; env: Env; auth: ReturnType<typeof createAuth> } | null =
  null;

function getAuth(env: Env, origin: string) {
  if (cachedAuth && cachedAuth.origin === origin && cachedAuth.env === env) {
    return cachedAuth.auth;
  }
  const auth = createAuth(env, origin);
  cachedAuth = { origin, env, auth };
  return auth;
}

const handler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith("/v1/")) return fail("not found", 404);

    const auth = getAuth(env, url.origin);

    // Better Auth owns everything under /v1/auth — signup, signin, the
    // Google redirect and callback, session refresh, signout.
    if (pathname.startsWith("/v1/auth/")) {
      return auth.handler(request);
    }

    try {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) return fail("unauthorized", 401);

      const userId = session.user.id;
      const state = await loadState(env, userId);
      // The session outlived the account it belongs to.
      if (!state) return fail("unauthorized", 401);

      if (pathname === "/v1/live") {
        if (request.method !== "GET") return fail("method not allowed", 405);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return fail("websocket upgrade required", 426);
        }
        const connection = url.searchParams.get("c");
        return await connectLive(
          request,
          env,
          userId,
          state.rev,
          connection && CONNECTION_ID.test(connection) ? connection : null,
        );
      }

      const blobMatch = pathname.match(/^\/v1\/blobs\/([^/]+)$/);
      if (blobMatch) {
        let blobId: string;
        try {
          blobId = decodeURIComponent(blobMatch[1]);
        } catch {
          return fail("invalid image id", 400);
        }
        if (!BLOB_ID.test(blobId)) return fail("invalid image id", 400);
        if (request.method === "PUT") {
          return await putBlob(request, env, userId, blobId, state);
        }
        if (request.method === "GET") {
          return await getBlob(env, userId, blobId);
        }
        if (request.method === "DELETE") {
          return await deleteBlob(env, userId, blobId);
        }
        return fail("method not allowed", 405);
      }

      if (pathname === "/v1/sync") {
        if (request.method === "GET") {
          return await pull(request, env, userId, state);
        }
        if (request.method === "POST") {
          return await push(request, env, userId, state, ctx);
        }
        return fail("method not allowed", 405);
      }

      if (pathname === "/v1/state") {
        if (request.method === "GET") return readState(state);
        if (request.method === "PUT") {
          return await writeState(request, env, userId, state);
        }
        return fail("method not allowed", 405);
      }

      if (pathname === "/v1/me" && request.method === "DELETE") {
        return await deleteMe(env, userId);
      }

      return fail("not found", 404);
    } catch (error) {
      // Never echo an exception: it could carry a fragment of a payload, and
      // payloads are the one thing this service promises not to reveal.
      const message =
        error instanceof Error &&
        /request body (was not valid JSON|is too large)/.test(error.message)
          ? error.message
          : "the request could not be completed";
      return fail(
        message,
        message === "the request could not be completed" ? 500 : 400,
      );
    }
  },
};

export default handler;

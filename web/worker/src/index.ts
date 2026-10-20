import { appOrigins, createAuth } from "./auth";
import type { Env } from "./env";
export { SyncHub } from "./live";

/**
 * The API.
 *
 * Six surfaces, all under `/v1/` on the same origin as the website — and,
 * cross-origin, for the desktop app (see "CORS" below):
 *
 *   /v1/auth/*     Better Auth — email+password, Google, sessions
 *   /v1/threads    conversations and their messages
 *   /v1/delta      what changed since a revision
 *   /v1/state      the user's settings blob and encryption mode
 *   /v1/blobs/*    client-encrypted image, attachment and spill objects in R2
 *   /v1/live       hibernating realtime invalidation socket
 *   /v1/me         delete everything
 *
 * ## This service is now the source of truth
 *
 * It used to be a replica. The browser held the real data in IndexedDB and
 * this Worker stored an opaque mirror of it — one flat `record` table with no
 * type, no parent link and no ordering, reconciled through a cursor the
 * client had to advance exactly right or rows disappeared. Three separate
 * data-loss bugs came out of that one shape, and all three were the same bug:
 * two stores and a rule for merging them.
 *
 * There is one store now. `thread` and `message` are typed, ordered, and
 * queryable, so the client holds nothing durable and a missed notification
 * costs latency instead of rows.
 *
 * ## The CPU budget is still the design constraint
 *
 * Workers bill CPU and the free tier allows 10ms per request. Three decisions
 * follow, and all three are load-bearing rather than micro-optimisation:
 *
 *  - Password stretching happens in the browser (see `auth.ts`), so this
 *    Worker never runs a slow hash.
 *  - Sessions are read from a signed cookie for five minutes at a time
 *    rather than from D1 on every call.
 *  - The router matches the path *before* it resolves a session or loads
 *    account state. Every request used to pay both up front, including 404s
 *    and the WebSocket upgrade; now each route asks for exactly what it uses.
 *
 * Every read below is one or two indexed queries, and every write is a single
 * `batch()` — one round trip, one implicit transaction.
 *
 * ## Trust boundary
 *
 * `meta`, `payload` and `settings` are opaque. Nothing here parses, indexes
 * or logs them. The structural columns around them — which thread, what
 * order, when, pinned or not — are in the clear on purpose, because sorting
 * and grouping cannot be done through a seal. `schema-app.sql` states exactly
 * what that discloses.
 */

/* ------------------------------- limits -------------------------------- */

/** Threads returned by one list page. */
const THREAD_PAGE_SIZE = 200;
/** Messages returned by one thread read. */
const MESSAGE_PAGE_SIZE = 200;
/** Thread rows returned by one delta page. */
const DELTA_PAGE_SIZE = 200;

const MAX_PAYLOAD_CHARS = 128 * 1024;
const MAX_META_CHARS = 32 * 1024;
const MAX_SETTINGS_CHARS = 64 * 1024;

/**
 * Messages one write may carry.
 *
 * Deliberately set so that `MAX_MESSAGES_PER_WRITE * MAX_PAYLOAD_CHARS`
 * (6.4 MB) stays *under* `MAX_BODY_BYTES` (8 MB). The old pair did not: 100
 * records at 128KB was 12.8 MB against an 8 MB body cap, so a batch that
 * satisfied every documented per-record limit could still be rejected — with
 * "request body is too large" and a 400, rather than the 413 the size limits
 * promised. Changing either number means re-checking this relationship.
 */
const MAX_MESSAGES_PER_WRITE = 50;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 11 * 1024 * 1024;

/**
 * Stop filling a page once the payloads reach this much.
 *
 * Ingress was capped and egress was not. A 250-row page of 128KB payloads
 * would have been a 32 MB synchronous `JSON.stringify`, which is by far the
 * largest single piece of CPU this file could be asked to do. Row counts do
 * not bound response size when rows vary by three orders of magnitude, so
 * the budget is measured in characters and the page simply ends early.
 */
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

/**
 * How long a deleted thread's tombstone survives.
 *
 * It exists only so a device that is connected *right now* learns the thread
 * disappeared. A device that misses the window needs nothing: it stores
 * nothing locally, so its next list request simply will not contain the
 * thread. Rows are purged lazily inside the next delete's batch.
 */
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ids are minted by the client — `crypto.randomUUID()` for threads and the
 * AI SDK's own ids for messages. Both are bounded and alphanumeric; anything
 * else is a client bug or an attack, and neither should reach a bind.
 */
const ID = /^[A-Za-z0-9_-]{1,96}$/;

/**
 * `g` generated image · `f` user attachment · `p` a spilled record payload
 * that did not fit in D1.
 *
 * The thread id leads the key, so deleting a conversation is one R2 prefix
 * delete. It used to be keyed by record id alone, which meant a thread's
 * cleanup was one unbounded list/delete loop *per message* — a single delete
 * could fan out a hundred of them.
 */
const BLOB_ID =
  /^[A-Za-z0-9_-]{1,96}\/[A-Za-z0-9_-]{1,96}\.(?:g|f|p)\.\d{1,4}\.\d{1,4}$/;

const ENCRYPTION_MODES = new Set(["none", "password", "passphrase"]);

type StateRow = {
  rev: number;
  encryption: string;
  settings: string | null;
  blob_bytes: number;
  blob_count: number;
  writes_day: number;
  writes_today: number;
};

type ThreadRow = {
  id: string;
  rev: number;
  meta: string | null;
  pinned: number;
  deleted: number;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  seq: number;
  rev: number;
  payload: string | null;
  updated_at: number;
};

/**
 * How much R2 one account may hold.
 *
 * R2's free tier is 10GB for the whole bucket, and until this existed nothing
 * stopped a single signed-in account from filling it — every other limit here
 * is per request, which bounds nothing cumulative. Overridable per deployment
 * so the ceiling can move without a code change.
 */
const DEFAULT_BLOB_QUOTA_BYTES = 250 * 1024 * 1024;

function blobQuota(env: Env): number {
  const configured = Number(env.BLOB_QUOTA_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_BLOB_QUOTA_BYTES;
}

/**
 * How many rows one account may write in a day.
 *
 * The blob quota bounds R2; this bounds D1, which is the metered side. Every
 * other limit is per request and caps a single call rather than a sustained
 * loop, so without this one authenticated client could spend the whole
 * deployment's daily row-write allowance in minutes. The ceiling sits far
 * above any real session — a long streaming answer costs roughly twenty rows
 * — and far below the free tier's daily total.
 */
const DEFAULT_DAILY_WRITE_LIMIT = 10_000;

function dailyWriteLimit(env: Env): number {
  const configured = Number(env.DAILY_WRITE_LIMIT);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DAILY_WRITE_LIMIT;
}

/** Days since the epoch — the bucket the write counter resets on. */
function epochDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/* ------------------------------- helpers ------------------------------- */

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
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

/** A non-negative integer from a query string, or null when malformed. */
function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read the account row, creating it on first contact.
 *
 * Lazily rather than at signup so the Google OAuth callback needs no special
 * case. The foreign key to `"user"(id)` *is* the existence check: a violation
 * means the session outlived the account it belongs to, which the router
 * turns into a 401. Without that branch the request hit the constraint and
 * 500'd — a deleted account failing open.
 */
async function loadState(env: Env, userId: string): Promise<StateRow | null> {
  const found = await env.DB.prepare(
    `SELECT rev, encryption, settings, blob_bytes, blob_count,
            writes_day, writes_today
       FROM user_state WHERE user_id = ?`,
  )
    .bind(userId)
    .first<StateRow>();
  if (found) return found;

  try {
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

  return {
    rev: 0,
    encryption: "none",
    settings: null,
    blob_bytes: 0,
    blob_count: 0,
    writes_day: 0,
    writes_today: 0,
  };
}

/**
 * The statement that allocates a revision, and the guard that goes with it.
 *
 * This must be the *first* statement of the batch that writes the rows
 * belonging to the revision. `batch()` is one implicit transaction, so the
 * inserts read the new value back through `(SELECT rev FROM user_state …)`
 * and no concurrent reader can see a revision before its rows exist.
 *
 * Two earlier versions of this were silent data loss rather than untidiness.
 * Deriving `rev + 1` from a row read at the top of the request let two
 * devices write the same revision, and a third that pulled between them
 * skipped one batch for ever. Fixing that with `UPDATE … RETURNING` but
 * leaving it as its own statement left a narrower window with the same shape.
 *
 * The daily write counter is advanced by this same statement, so bounding D1
 * spend costs no extra round trip and no extra CPU.
 */
function allocate(env: Env, userId: string, writes: number) {
  return env.DB.prepare(
    `UPDATE user_state
        SET rev = rev + 1,
            updated_at = ?1,
            writes_today =
              CASE WHEN writes_day = ?2 THEN writes_today + ?3 ELSE ?3 END,
            writes_day = ?2
      WHERE user_id = ?4
     RETURNING rev`,
  ).bind(Date.now(), epochDay(), writes, userId);
}

/** True when this account has already spent its day's row-write budget. */
function overDailyLimit(env: Env, state: StateRow): boolean {
  const spent = state.writes_day === epochDay() ? state.writes_today : 0;
  return spent >= dailyWriteLimit(env);
}

const RATE_LIMITED =
  "this account has reached its daily sync limit — it resets within 24 hours";

/**
 * Run a write batch and return the revision it allocated.
 *
 * The batch fails as a unit only when the state row is gone: the inserts then
 * have no revision to read and the NOT NULL constraint rolls everything back.
 * That is a session outliving its account, and it must fail closed.
 */
async function commit(
  env: Env,
  statements: D1PreparedStatement[],
): Promise<number | null> {
  try {
    const [allocation] = await env.DB.batch<{ rev: number }>(statements);
    const rev = allocation.results?.[0]?.rev;
    return typeof rev === "number" ? rev : null;
  } catch {
    return null;
  }
}

/* ------------------------------- threads ------------------------------- */

function threadJson(row: ThreadRow) {
  return {
    id: row.id,
    rev: row.rev,
    meta: row.meta,
    pinned: row.pinned === 1,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /v1/threads — the sidebar, in one indexed query.
 *
 * `ETag` is the account revision. A device that reloads without having missed
 * anything gets a 304 and this endpoint never runs its query or serialises a
 * response; that matters more than it used to, because with no local store
 * every single page load asks for this list.
 */
async function listThreads(
  request: Request,
  env: Env,
  userId: string,
  state: StateRow,
): Promise<Response> {
  const etag = `W/"${state.rev}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "no-store" },
    });
  }

  const url = new URL(request.url);
  const offset = intParam(url, "offset");
  if (offset === null) return fail("offset must be a non-negative integer", 400);

  const { results } = await env.DB.prepare(
    `SELECT id, rev, meta, pinned, deleted, created_at, updated_at
       FROM thread
      WHERE user_id = ? AND deleted = 0
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(userId, THREAD_PAGE_SIZE, offset)
    .all<ThreadRow>();

  // `no-cache` rather than `no-store`: the browser must revalidate before
  // reusing this, but it is allowed to *hold* it, which is what makes the
  // 304 above worth sending. `no-store` would forbid the cache entry and the
  // conditional request would never happen.
  return json(
    {
      rev: state.rev,
      threads: results.map(threadJson),
      hasMore: results.length === THREAD_PAGE_SIZE,
    },
    200,
    { ETag: etag, "Cache-Control": "private, no-cache" },
  );
}

/**
 * GET /v1/threads/:id — one thread and its messages, in order.
 *
 * Two indexed queries. The message page is bounded by both a row count and a
 * character budget, because a thread of long reasoning answers can reach the
 * response ceiling well before it reaches the row ceiling.
 */
async function readThread(
  request: Request,
  env: Env,
  userId: string,
  threadId: string,
  state: StateRow,
): Promise<Response> {
  const url = new URL(request.url);
  const after = intParam(url, "after");
  if (after === null) return fail("after must be a non-negative integer", 400);
  // Messages at or below this revision come back without their payload: the
  // caller already holds them. Every row still comes back as (id, seq, rev),
  // which is how a deletion made elsewhere shows up — as a row that is gone.
  const since = url.searchParams.has("since") ? intParam(url, "since") : 0;
  if (since === null) return fail("since must be a non-negative integer", 400);

  const thread = await env.DB.prepare(
    `SELECT id, rev, meta, pinned, deleted, created_at, updated_at
       FROM thread WHERE user_id = ? AND id = ?`,
  )
    .bind(userId, threadId)
    .first<ThreadRow>();
  if (!thread || thread.deleted === 1) return fail("thread not found", 404);

  const { results } = await env.DB.prepare(
    `SELECT id, seq, rev,
            CASE WHEN rev > ?4 THEN payload END AS payload,
            updated_at
       FROM message
      WHERE user_id = ?1 AND thread_id = ?2 AND seq >= ?3
      ORDER BY seq
      LIMIT ?5`,
  )
    .bind(userId, threadId, after, since, MESSAGE_PAGE_SIZE)
    .all<MessageRow>();

  // Trim to the character budget rather than the row count when payloads are
  // large. `hasMore` then tells the client to ask again from the next seq.
  const messages: ReturnType<typeof messageJson>[] = [];
  let budget = MAX_RESPONSE_CHARS;
  let truncated = false;
  for (const row of results) {
    const size = row.payload?.length ?? 0;
    if (messages.length > 0 && size > budget) {
      truncated = true;
      break;
    }
    budget -= size;
    messages.push(messageJson(row));
  }

  return json({
    rev: state.rev,
    thread: threadJson(thread),
    messages,
    hasMore: truncated || results.length === MESSAGE_PAGE_SIZE,
  });
}

function messageJson(row: MessageRow) {
  return {
    id: row.id,
    seq: row.seq,
    rev: row.rev,
    payload: row.payload,
    updatedAt: row.updated_at,
  };
}

type IncomingMessage = { id: string; seq: number; payload: string };

/**
 * PUT /v1/threads/:id — write a turn.
 *
 * One endpoint rather than three, because a turn is one atomic thing: it can
 * create the thread, truncate a tail, and write messages, and doing those as
 * separate requests would mean a visible half-applied state and three round
 * trips on the hottest path in the app.
 *
 * Body, all fields optional:
 *   meta          sealed thread metadata — presence implies a thread write
 *   pinned        boolean, written with `meta`
 *   createdAt     honoured on insert only
 *   truncateFrom  delete messages at `seq >= n` before writing
 *   messages      [{ id, seq, payload }]
 *   touch         bump the thread's revision and timestamp
 *   client        this device's live-socket id, so it is not woken by itself
 *
 * `touch` is what a streaming checkpoint leaves out. A long answer writes its
 * assistant message every few seconds, and bumping the thread row alongside
 * it would double the row writes for the turn to say something no reader
 * needs — the delta probe already notices the message moving.
 */
async function writeThread(
  request: Request,
  env: Env,
  userId: string,
  threadId: string,
  state: StateRow,
  ctx: ExecutionContext,
): Promise<Response> {
  if (overDailyLimit(env, state)) return fail(RATE_LIMITED, 429);

  const body = (await readJson(request)) as {
    meta?: unknown;
    pinned?: unknown;
    createdAt?: unknown;
    truncateFrom?: unknown;
    messages?: unknown;
    touch?: unknown;
    client?: unknown;
  };

  const writesThread = body.meta !== undefined;
  if (writesThread) {
    if (typeof body.meta !== "string" || body.meta.length === 0) {
      return fail("meta must be a non-empty string", 400);
    }
    if (body.meta.length > MAX_META_CHARS) {
      return fail("meta exceeded the 32KB limit", 413);
    }
  }

  let truncateFrom: number | null = null;
  if (body.truncateFrom !== undefined) {
    if (
      typeof body.truncateFrom !== "number" ||
      !Number.isInteger(body.truncateFrom) ||
      body.truncateFrom < 0
    ) {
      return fail("truncateFrom must be a non-negative integer", 400);
    }
    truncateFrom = body.truncateFrom;
  }

  const messages: IncomingMessage[] = [];
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) {
      return fail("messages must be an array", 400);
    }
    if (body.messages.length > MAX_MESSAGES_PER_WRITE) {
      return fail(`write at most ${MAX_MESSAGES_PER_WRITE} messages at a time`, 400);
    }
    for (const raw of body.messages) {
      const item = raw as { id?: unknown; seq?: unknown; payload?: unknown };
      if (typeof item.id !== "string" || !ID.test(item.id)) {
        return fail("each message needs a valid id", 400);
      }
      if (
        typeof item.seq !== "number" ||
        !Number.isInteger(item.seq) ||
        item.seq < 0
      ) {
        return fail("each message needs a non-negative integer seq", 400);
      }
      if (typeof item.payload !== "string" || item.payload.length === 0) {
        return fail("each message needs a payload", 400);
      }
      if (item.payload.length > MAX_PAYLOAD_CHARS) {
        return fail("a message exceeded the 128KB payload limit", 413);
      }
      messages.push({ id: item.id, seq: item.seq, payload: item.payload });
    }
  }

  if (!writesThread && messages.length === 0 && truncateFrom === null) {
    return fail("nothing to write", 400);
  }

  const now = Date.now();
  const touch = writesThread || body.touch === true;
  const writes = (writesThread ? 1 : 0) + messages.length + (touch ? 1 : 0);

  const statements: D1PreparedStatement[] = [allocate(env, userId, writes)];

  /*
   * Order inside the batch is load-bearing.
   *
   * The thread upsert comes first because `message` has a foreign key onto
   * it, so a brand-new thread and its first message can be written in the
   * same transaction. The truncate comes next, before the inserts: an
   * edit-and-resend truncates from seq 3 and immediately writes a new message
   * at seq 3, and doing those in the other order would delete the message
   * that was just written.
   */
  if (writesThread) {
    const createdAt =
      typeof body.createdAt === "number" && Number.isFinite(body.createdAt)
        ? body.createdAt
        : now;
    statements.push(
      env.DB.prepare(
        `INSERT INTO thread
              (user_id, id, rev, meta, pinned, deleted, created_at, updated_at)
            VALUES (?1, ?2, (SELECT rev FROM user_state WHERE user_id = ?1),
                    ?3, ?4, 0, ?5, ?6)
         ON CONFLICT(user_id, id) DO UPDATE SET
              rev = excluded.rev,
              meta = excluded.meta,
              pinned = excluded.pinned,
              deleted = 0,
              updated_at = excluded.updated_at`,
      ).bind(userId, threadId, body.meta, body.pinned === true ? 1 : 0, createdAt, now),
    );
  } else if (touch) {
    statements.push(
      env.DB.prepare(
        `UPDATE thread
            SET rev = (SELECT rev FROM user_state WHERE user_id = ?1),
                updated_at = ?3
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(userId, threadId, now),
    );
  }

  if (truncateFrom !== null) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM message
          WHERE user_id = ? AND thread_id = ? AND seq >= ?`,
      ).bind(userId, threadId, truncateFrom),
    );
  }

  /*
   * `WHERE EXISTS` is what stops a message being written into a thread that
   * is not there.
   *
   * The case is real rather than defensive: one device deletes a thread while
   * another is streaming an answer into it, and that second device's next
   * checkpoint arrives seconds later. Without the guard those rows land with
   * a `thread_id` nothing points at — invisible to every read, because reads
   * go through the thread, and therefore never cleaned up. With it, a write
   * to a deleted thread is silently dropped, which is exactly what should
   * happen to it.
   *
   * A brand-new thread is unaffected: its upsert is earlier in this same
   * transaction, so the row already exists by the time these run.
   */
  for (const message of messages) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO message
              (user_id, id, thread_id, seq, rev, payload, updated_at)
            SELECT ?1, ?2, ?3, ?4,
                   (SELECT rev FROM user_state WHERE user_id = ?1), ?5, ?6
             WHERE EXISTS (SELECT 1 FROM thread
                            WHERE user_id = ?1 AND id = ?3 AND deleted = 0)
         ON CONFLICT(user_id, id) DO UPDATE SET
              thread_id = excluded.thread_id,
              seq = excluded.seq,
              rev = excluded.rev,
              payload = excluded.payload,
              updated_at = excluded.updated_at`,
      ).bind(userId, message.id, threadId, message.seq, message.payload, now),
    );
  }

  const rev = await commit(env, statements);
  if (rev === null) return fail("unauthorized", 401);

  ctx.waitUntil(
    notifyLive(
      env,
      userId,
      rev,
      threadId,
      typeof body.client === "string" && body.client.length <= 64
        ? body.client
        : null,
    ),
  );

  return json({ rev, applied: messages.length });
}

/**
 * DELETE /v1/threads/:id — soft-delete the thread, hard-delete its contents.
 *
 * The thread row survives as a tombstone only long enough for connected
 * devices to notice; the messages, which are the bulk of the storage, go
 * immediately. Expired tombstones from previous deletions are swept in the
 * same batch, so the cleanup costs no scheduled job and no extra request.
 */
async function deleteThread(
  env: Env,
  userId: string,
  threadId: string,
  state: StateRow,
  ctx: ExecutionContext,
  client: string | null,
): Promise<Response> {
  if (overDailyLimit(env, state)) return fail(RATE_LIMITED, 429);

  const now = Date.now();
  const rev = await commit(env, [
    allocate(env, userId, 1),
    env.DB.prepare(
      `UPDATE thread
          SET deleted = 1,
              meta = NULL,
              rev = (SELECT rev FROM user_state WHERE user_id = ?1),
              updated_at = ?3
        WHERE user_id = ?1 AND id = ?2`,
    ).bind(userId, threadId, now),
    env.DB.prepare(`DELETE FROM message WHERE user_id = ? AND thread_id = ?`).bind(
      userId,
      threadId,
    ),
    env.DB.prepare(
      `DELETE FROM thread
        WHERE user_id = ? AND deleted = 1 AND updated_at < ?`,
    ).bind(userId, now - PURGE_AFTER_MS),
  ]);
  if (rev === null) return fail("unauthorized", 401);

  // One prefix delete for the whole conversation. Keying blobs by thread is
  // what makes this O(1) requests instead of one unbounded list/delete loop
  // per message.
  ctx.waitUntil(deleteThreadBlobs(env, userId, threadId));
  ctx.waitUntil(notifyLive(env, userId, rev, threadId, client));

  return json({ rev, deleted: true });
}

/**
 * GET /v1/delta?since=N&thread=ID — what a connected device needs to re-read.
 *
 * The client holds exactly two things: the thread list, and the messages of
 * the one thread it has open. So this answers exactly two questions — which
 * thread rows moved, and did anything inside the open thread move — and the
 * second is a boolean rather than a list, because the client's response
 * either way is to re-read the whole thread in one indexed query.
 *
 * This is a freshness hint over an authoritative store. Missing it costs a
 * beat of latency; it cannot cost data, which is the property the old
 * cursor-based pull never had.
 */
async function readDelta(
  request: Request,
  env: Env,
  userId: string,
  state: StateRow,
): Promise<Response> {
  const url = new URL(request.url);
  const since = intParam(url, "since");
  if (since === null) return fail("since must be a non-negative integer", 400);

  const openThread = url.searchParams.get("thread");
  if (openThread !== null && !ID.test(openThread)) {
    return fail("thread must be a valid id", 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, rev, meta, pinned, deleted, created_at, updated_at
       FROM thread
      WHERE user_id = ? AND rev > ?
      ORDER BY rev
      LIMIT ?`,
  )
    .bind(userId, since, DELTA_PAGE_SIZE)
    .all<ThreadRow>();

  let threadChanged = false;
  if (openThread) {
    const hit = await env.DB.prepare(
      `SELECT 1 AS present
         FROM message
        WHERE user_id = ? AND rev > ? AND thread_id = ?
        LIMIT 1`,
    )
      .bind(userId, since, openThread)
      .first<{ present: number }>();
    threadChanged = hit !== null;
  }

  // A full page is not the end. Reporting the account's revision with it
  // moved the caller's cursor past every row this page left out, and those
  // threads were never asked for again; the last row's revision is where the
  // next page starts.
  const hasMore = results.length === DELTA_PAGE_SIZE;
  return json({
    rev: hasMore ? results[results.length - 1].rev : state.rev,
    threads: results.map(threadJson),
    threadChanged,
    hasMore,
  });
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
  const path = blobId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/${encodeURIComponent(userId)}/${path}`;
}

async function putBlob(
  request: Request,
  env: Env,
  userId: string,
  blobId: string,
  state: StateRow,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BLOB_BYTES) return fail("file exceeded 11 MB", 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return fail("file was empty", 400);
  if (bytes.byteLength > MAX_BLOB_BYTES) return fail("file exceeded 11 MB", 413);

  const key = blobKey(userId, blobId);

  /*
   * Blob ids are deterministic, so a retry overwrites an existing object
   * rather than adding one. The previous size has to come out of the total or
   * a single image re-uploaded often enough would exhaust the quota while
   * occupying one object's worth of space. `head` is a metadata read: a Class
   * B operation and no transfer.
   */
  const existing = await env.BLOBS.head(key);
  const previous = existing?.size ?? 0;
  const quota = blobQuota(env);

  /*
   * Reserve the space before writing, in one conditional statement.
   *
   * Checking `state.blob_bytes` — a value read at the top of the request —
   * and then writing was a time-of-check/time-of-use gap: N concurrent
   * uploads all saw the same pre-value, all passed, and the account
   * overshot by N-1 objects. Letting the database do the comparison closes
   * it, because `blob_bytes` is read and written by the same statement.
   */
  const reservation = await env.DB.prepare(
    `UPDATE user_state
        SET blob_bytes = MAX(0, blob_bytes - ?1 + ?2),
            blob_count = MAX(0, blob_count + ?3)
      WHERE user_id = ?4 AND blob_bytes - ?1 + ?2 <= ?5`,
  )
    .bind(previous, bytes.byteLength, existing ? 0 : 1, userId, quota)
    .run();

  if (reservation.meta.changes === 0) {
    return fail(
      `this account's ${Math.round(quota / (1024 * 1024))} MB of file storage is full — delete some conversations with images or attachments`,
      507,
    );
  }

  let object: R2Object;
  try {
    object = await env.BLOBS.put(key, bytes, {
      httpMetadata: {
        contentType: "application/octet-stream",
        // A retry can replace a deterministic key, so stale ciphertext must
        // never be cached under the custom-domain URL.
        cacheControl: "no-store",
      },
    });
  } catch (error) {
    // Give the reservation back. Without this a failed upload would charge
    // the account for bytes it does not hold, permanently — there is no
    // reconciliation pass to notice.
    await env.DB.prepare(
      `UPDATE user_state
          SET blob_bytes = MAX(0, blob_bytes + ?1 - ?2),
              blob_count = MAX(0, blob_count - ?3)
        WHERE user_id = ?4`,
    )
      .bind(previous, bytes.byteLength, existing ? 0 : 1, userId)
      .run();
    throw error;
  }

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
  if (!object) return fail("file not found", 404);
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
  const key = blobKey(userId, blobId);
  const existing = await env.BLOBS.head(key);
  await env.BLOBS.delete(key);
  if (existing) {
    await env.DB.prepare(
      `UPDATE user_state
          SET blob_bytes = MAX(0, blob_bytes - ?),
              blob_count = MAX(0, blob_count - 1)
        WHERE user_id = ?`,
    )
      .bind(existing.size, userId)
      .run();
  }
  return new Response(null, { status: 204 });
}

async function deleteBlobPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  // Restart at the prefix after each delete. Continuing an opaque cursor
  // through a collection we just mutated can skip keys on some object stores.
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) return { bytes, count };
    for (const object of page.objects) {
      bytes += object.size;
      count += 1;
    }
    await bucket.delete(page.objects.map((object) => object.key));
  }
}

/**
 * The account's files — generated images (`g`) and attachments (`f`) — for
 * Settings → Privacy → Storage. Metadata only: ids, sizes and upload times,
 * a page of 500 per R2 list. What each file *is* — its type, its pixels —
 * stays sealed; the browser downloads and decrypts the ones it shows.
 * Spilled payloads (`p`) are records that did not fit in D1, not files, and
 * are left out.
 */
async function listBlobs(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > 1024) return fail("invalid cursor", 400);
  const prefix = `${userId}/`;
  let page: R2Objects;
  try {
    page = await env.BLOBS.list({ prefix, limit: 500, cursor });
  } catch {
    return fail("invalid cursor", 400);
  }
  const files = page.objects
    .map((object) => ({
      id: object.key.slice(prefix.length),
      size: object.size,
      uploaded: object.uploaded.getTime(),
    }))
    .filter((file) => BLOB_ID.test(file.id) && !/\.p\.\d+\.\d+$/.test(file.id));
  return json({ files, cursor: page.truncated ? page.cursor : null });
}

/** Every image, attachment and spilled payload belonging to one thread. */
async function deleteThreadBlobs(
  env: Env,
  userId: string,
  threadId: string,
): Promise<void> {
  const freed = await deleteBlobPrefix(env.BLOBS, `${userId}/${threadId}/`);
  if (freed.count === 0) return;
  await env.DB.prepare(
    `UPDATE user_state
        SET blob_bytes = MAX(0, blob_bytes - ?),
            blob_count = MAX(0, blob_count - ?)
      WHERE user_id = ?`,
  )
    .bind(freed.bytes, freed.count, userId)
    .run();
}

async function notifyLive(
  env: Env,
  userId: string,
  rev: number,
  thread: string | null,
  exclude: string | null,
  settings = false,
): Promise<void> {
  const stub = env.LIVE.get(env.LIVE.idFromName(userId));
  await stub.fetch("https://live.internal/notify", {
    method: "POST",
    body: JSON.stringify({ rev, thread, exclude, settings }),
  });
}

/** Connection ids only ever come back to us as a tag to skip. */
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A WebSocket handshake cannot carry an `Authorization` header, so the
 * desktop app offers its session token as a subprotocol instead:
 * `chat.v1, bearer.<token as base64url>`. The hub answers with `chat.v1`
 * alone — a browser fails a handshake that offered subprotocols and got none
 * back. The website sends neither and authenticates with its cookie.
 */
const LIVE_PROTOCOL = "chat.v1";
const LIVE_BEARER = "bearer.";

function offeredProtocols(request: Request): string[] {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

/** The headers to resolve a session from: a live socket's token, made a header. */
function sessionHeaders(request: Request, pathname: string): Headers {
  if (pathname !== "/v1/live") return request.headers;
  const offered = offeredProtocols(request).find((protocol) =>
    protocol.startsWith(LIVE_BEARER),
  );
  if (!offered) return request.headers;
  try {
    const encoded = offered.slice(LIVE_BEARER.length).replace(/-/g, "+").replace(/_/g, "/");
    const token = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return headers;
  } catch {
    return request.headers;
  }
}

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
  const protocol = offeredProtocols(request).includes(LIVE_PROTOCOL)
    ? `&p=${LIVE_PROTOCOL}`
    : "";
  return stub.fetch(
    `https://live.internal/connect?rev=${rev}${query}${protocol}`,
    { headers },
  );
}

/* -------------------------------- state -------------------------------- */

/**
 * GET /v1/state — settings blob, encryption mode, and what this account uses.
 *
 * The blob totals are already on the row, so they cost nothing. The counts
 * are two indexed queries and are deliberately kept here rather than in
 * `loadState`: this endpoint is called when someone opens settings, not on
 * every write.
 */
async function readState(
  env: Env,
  userId: string,
  state: StateRow,
): Promise<Response> {
  // `thread_list` leads with (user_id, deleted), so this is an index range
  // rather than a scan. The equivalent COUNT on the old `record` table could
  // not use its index for the `deleted` predicate and read every row on the
  // account.
  const [threads, messages] = await env.DB.batch<{ n: number }>([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM thread WHERE user_id = ? AND deleted = 0`,
    ).bind(userId),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM message WHERE user_id = ?`).bind(
      userId,
    ),
  ]);

  /*
   * The counter self-heal is gone, deliberately.
   *
   * It existed to backfill accounts created before `blob_bytes` /
   * `blob_count` did, by listing the account's R2 prefix whenever both read
   * zero. That era ended with the opaque record store: every account now
   * maintains its counters from its first upload, so the branch could only
   * fire for an account that genuinely holds nothing — and then it put an
   * unbounded R2 list on a request path to confirm it.
   *
   * It also actively lied after the reset. Objects written under the old
   * per-message key scheme are unreachable by the thread-prefixed scheme, so
   * re-measuring the prefix would report files no conversation references and
   * no deletion could ever clear.
   */
  return json({
    rev: state.rev,
    encryption: state.encryption,
    settings: state.settings,
    usage: {
      blobBytes: state.blob_bytes,
      blobCount: state.blob_count,
      blobQuota: blobQuota(env),
      threads: threads.results?.[0]?.n ?? 0,
      messages: messages.results?.[0]?.n ?? 0,
    },
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
  ctx: ExecutionContext,
): Promise<Response> {
  const body = (await readJson(request)) as {
    settings?: unknown;
    encryption?: unknown;
    client?: unknown;
    notify?: unknown;
  };

  // Checked for presence, not just type. An omitted key used to reach the
  // bind as `undefined`, which D1 rejects — surfacing a malformed request as
  // a 500 instead of the 400 it is.
  if (!(body !== null && typeof body === "object" && "settings" in body)) {
    return fail("settings is required", 400);
  }
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

  // Tell this account's other devices to re-read their settings. The client
  // says whether the change is worth it: the open thread and rail geometry
  // are written on every switch and drag, and belong to the device that made
  // them.
  if (body.notify === true) {
    const client =
      typeof body.client === "string" && CONNECTION_ID.test(body.client)
        ? body.client
        : null;
    ctx.waitUntil(notifyLive(env, userId, state.rev, null, client, true));
  }

  return json({ ok: true, encryption });
}

/**
 * DELETE /v1/me — erase the account and everything attached to it.
 *
 * Present from day one deliberately. This app stores a name, a date of birth,
 * an email and the full text of people's conversations; a delete path that
 * actually works is the minimum that justifies collecting any of it. The
 * foreign keys cascade, so one statement clears sessions, OAuth links,
 * settings, threads and messages together.
 *
 * D1 goes first. The old order cleared R2 and then D1, unguarded, so a throw
 * partway through the unbounded R2 loop left the identity alive with half its
 * ciphertext missing. Removing the identity is what makes the account gone;
 * the object cleanup is bookkeeping and belongs after it, in `waitUntil`,
 * where a failure cannot fail the deletion the user asked for.
 */
async function deleteMe(
  env: Env,
  userId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  await env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(userId).run();
  ctx.waitUntil(
    deleteBlobPrefix(env.BLOBS, `${userId}/`).then(() => undefined),
  );

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

/* --------------------------------- CORS -------------------------------- */

/**
 * The desktop app is the only cross-origin caller.
 *
 * The website calls this API from its own origin and needs no CORS. The
 * desktop app ships its own copy of the UI, served from inside the app
 * (`appOrigins`), and reads these responses across origins — so those origins,
 * and only those, get `Access-Control-Allow-Origin`.
 *
 * Credentials are never allowed. The app authenticates with a bearer token
 * (`auth.ts`, 4), not the cookie, so `Access-Control-Allow-Credentials` stays
 * unset: no response a cookie authorised can be read by another origin,
 * whatever origin it claims.
 */
function corsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  return origin && appOrigins(env).includes(origin) ? origin : null;
}

function preflight(origin: string | null): Response {
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

/** `set-auth-token` is how the bearer plugin hands the app its session. */
function withCors(response: Response, origin: string | null): Response {
  // A 101 carries a socket, not a readable response; CORS does not apply.
  if (!origin || response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  const exposed = new Set(
    (headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean),
  );
  exposed.add("set-auth-token");
  headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
let cachedAuth: {
  origin: string;
  env: Env;
  auth: ReturnType<typeof createAuth>;
} | null = null;

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
    const origin = corsOrigin(request, env);
    if (request.method === "OPTIONS") return preflight(origin);
    return withCors(await route(request, env, ctx), origin);
  },
};

async function route(
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
    const session = await auth.api.getSession({
      headers: sessionHeaders(request, pathname),
    });
    if (!session?.user) return fail("unauthorized", 401);
    const userId = session.user.id;

    /*
     * Account state is loaded per route rather than up front.
     *
     * Every request used to pay `loadState` before the router had even
     * looked at the path, so a 404 and a WebSocket upgrade cost the same
     * D1 read as a write did. Blob reads are the clearest win: fetching an
     * image is now one R2 get and no D1 at all, and a page full of
     * generated images is exactly when that repeats.
     */
    const stateFor = async (): Promise<StateRow> => {
      const state = await loadState(env, userId);
      // The session outlived the account it belongs to.
      if (!state) throw new Unauthorized();
      return state;
    };

    if (pathname === "/v1/blobs") {
      if (request.method !== "GET") return fail("method not allowed", 405);
      return await listBlobs(request, env, userId);
    }

    const blobMatch = pathname.match(/^\/v1\/blobs\/(.+)$/);
    if (blobMatch) {
      let blobId: string;
      try {
        blobId = decodeURIComponent(blobMatch[1]);
      } catch {
        return fail("invalid file id", 400);
      }
      if (!BLOB_ID.test(blobId)) return fail("invalid file id", 400);
      if (request.method === "GET") return await getBlob(env, userId, blobId);
      if (request.method === "DELETE") {
        return await deleteBlob(env, userId, blobId);
      }
      if (request.method === "PUT") {
        return await putBlob(request, env, userId, blobId, await stateFor());
      }
      return fail("method not allowed", 405);
    }

    const threadMatch = pathname.match(/^\/v1\/threads\/([^/]+)$/);
    if (threadMatch) {
      let threadId: string;
      try {
        threadId = decodeURIComponent(threadMatch[1]);
      } catch {
        return fail("invalid thread id", 400);
      }
      if (!ID.test(threadId)) return fail("invalid thread id", 400);
      if (request.method === "GET") {
        return await readThread(request, env, userId, threadId, await stateFor());
      }
      if (request.method === "PUT") {
        return await writeThread(
          request,
          env,
          userId,
          threadId,
          await stateFor(),
          ctx,
        );
      }
      if (request.method === "DELETE") {
        const client = url.searchParams.get("client");
        return await deleteThread(
          env,
          userId,
          threadId,
          await stateFor(),
          ctx,
          client && CONNECTION_ID.test(client) ? client : null,
        );
      }
      return fail("method not allowed", 405);
    }

    if (pathname === "/v1/threads") {
      if (request.method !== "GET") return fail("method not allowed", 405);
      return await listThreads(request, env, userId, await stateFor());
    }

    if (pathname === "/v1/delta") {
      if (request.method !== "GET") return fail("method not allowed", 405);
      return await readDelta(request, env, userId, await stateFor());
    }

    if (pathname === "/v1/state") {
      if (request.method === "GET") {
        return await readState(env, userId, await stateFor());
      }
      if (request.method === "PUT") {
        return await writeState(request, env, userId, await stateFor(), ctx);
      }
      return fail("method not allowed", 405);
    }

    if (pathname === "/v1/live") {
      if (request.method !== "GET") return fail("method not allowed", 405);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return fail("websocket upgrade required", 426);
      }
      const state = await stateFor();
      const connection = url.searchParams.get("c");
      return await connectLive(
        request,
        env,
        userId,
        state.rev,
        connection && CONNECTION_ID.test(connection) ? connection : null,
      );
    }

    if (pathname === "/v1/me" && request.method === "DELETE") {
      return await deleteMe(env, userId, ctx);
    }

    return fail("not found", 404);
  } catch (error) {
    if (error instanceof Unauthorized) return fail("unauthorized", 401);
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
}

/** Thrown by `stateFor` so a missing account row unwinds to one 401. */
class Unauthorized extends Error {}

export default handler;

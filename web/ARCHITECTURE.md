# How this codebase works

A chat interface for every model OpenRouter serves, with accounts and
cross-device sync, that costs the operator **nothing to run**.

That last clause is not a nice-to-have. It is the constraint that explains
almost every structural decision below, and most of the surprising ones only
make sense once you hold it in mind: *no byte we pay for sits in the token
path, and nothing unbounded is billable.*

---

## 1. The shape of the system

Two programs, one store, and a browser that keeps nothing.

```
   Browser (the whole app)                    Cloudflare
  ┌─────────────────────────────┐            ┌───────────────────────────┐
  │  Next.js static export      │            │  Worker (chat.belayet.app)│
  │                             │            │   /v1/auth/*   Better Auth│
  │  ┌───────────────────────┐  │  session   │   /v1/threads  the data   │
  │  │ inference (streamText)├──┼──cookie───▶│   /v1/delta    what moved │
  │  └───────┬───────────────┘  │            │   /v1/state    settings   │
  │          │ user's own key   │            │   /v1/blobs/*  bytes      │
  │          ▼                  │            │   /v1/live     websocket  │
  │   openrouter.ai  ◀──────────┼────────────┼──(never)                  │
  │                             │            └────┬────────┬────────┬────┘
  │  in memory only:            │                 │        │        │
  │   · the sidebar             │                 ▼        ▼        ▼
  │   · the open thread         │                D1       R2    Durable
  │  on disk: a theme, a key    │          (threads +   (bytes)  Object
  └─────────────────────────────┘           messages)            (fanout)
```

**The frontend is a static export.** `next.config.ts` sets
`output: "export"`; there is no `app/api`, no route handler, no middleware.
Cloudflare serves those files free and unmetered, and — critically —
**static asset requests do not invoke the Worker**. `run_worker_first` is
scoped to `/v1/*` precisely to keep that true. Widening that glob puts every
page load onto the billable path, which is why it is called out as a hard
constraint in `CLAUDE.md`.

**Inference never touches our infrastructure.** The browser holds the user's
own OpenRouter key and talks to `openrouter.ai` directly. The operator is not
in the billing path at any volume, a long reasoning answer cannot hit a
function timeout because there is no function, and a generated image travels
once instead of twice.

**The Worker is the only server, and it holds the only copy.** It cannot read
the contents of what it stores — titles, messages, prompts and settings are
sealed in the browser — but it can see the shape: which messages belong to
which conversation, how many, in what order, and when. §12 states that
boundary precisely.

---

## 2. Where the money would go, and why it doesn't

| Surface | Free allowance | What we do about it |
|---|---|---|
| Static assets | unmetered | The entire frontend. Never invokes the Worker. |
| Model inference | — | User's key, browser→OpenRouter. Operator cost is structurally zero. |
| Worker CPU | 10 ms/request | Password stretching moved to the browser; sessions read from a signed cookie for 5 min. |
| D1 rows written | 100k/day | Only changed messages are pushed; streaming pushes are throttled. See §6.4. |
| D1 rows read | 5M/day | One or two indexed lookups per read. |
| R2 storage | 10 GB | **Per-account quota**, §8. The only cumulative surface. |
| Durable Objects | SQLite-backed, free tier | Hibernating sockets; idle accounts consume nothing. |

Measured on the deployed Worker with `wrangler tail`:

```
/v1/sync   GET     2 ms CPU   ← retired; the phase-13 routes replace it
/v1/sync   POST    1 ms CPU
/v1/me     DELETE  6 ms CPU
/v1/auth/sign-up   44 ms CPU   ← 4.4x the free-tier limit, not throttled
```

**The data-route numbers above are pre-phase-13 and need re-measuring.** The
shapes did not get heavier — every read is one or two indexed queries and
every write is a single `batch()` — but that is a prediction, and the standing
rule in §15 is not to believe one without `wrangler tail` in front of it.

Signup is the one outlier. It is Better Auth's own work plus D1 writes plus
the database-backed rate limiter, not instance construction — caching the auth
instance per isolate was tried and did not move it.

---

## 3. One store, and it is not in the browser

**D1 is the source of truth.** The browser holds the sidebar and the open
thread in memory and nothing on disk. This is the inversion of phase 13, and
it is the single most important fact about the current design: there is no
second copy, so there is nothing to reconcile.

The previous arrangement — Dexie as the truth, the cloud as a replica —
produced three separate silent data-loss bugs, and all three were the same
bug: two stores, a cursor, and a merge rule that had to be exactly right.
See §15.

| Store | Holds | Readable by us? |
|---|---|---|
| D1 `thread` | one row per conversation; sealed `meta`, plaintext sort keys | Titles/model/prompt **no**; shape **yes** |
| D1 `message` | one row per message; sealed `payload`, plaintext `thread_id`/`seq` | Content **no**; position **yes** |
| D1 `user_state` | settings blob, encryption mode, revision, storage totals | Settings blob is always encrypted |
| R2 | images, attachments, spilled payloads | **No** for password accounts |

**What the browser keeps**, and the reason each one survived:

| Where | What | Why it is allowed to exist |
|---|---|---|
| `localStorage["dial:appearance"]` | appearance, rail geometry, remember/lock device preference | The pre-paint script runs before any request and the locked screen needs the non-sensitive key-retention choice before sealed settings can open. |
| IndexedDB `dial-vault` | an optional, account-scoped, non-extractable `CryptoKey` | It is the only web storage that can hold one without exporting raw bytes. “Lock on exit” deletes it and keeps the key in memory only. |
| Cache API `dial-catalog-v1` | OpenRouter's public model list | An HTTP response with a TTL. Nothing here is the user's. |

Nothing else. No conversations, no messages, no thread ids, no model
credentials. Both
legacy stores — the `dial` database and the eight `dial:*` keys — are deleted
on load (`discardLegacyStores`, `purgeLegacyLocal`), because two of those keys
held the user's OpenRouter key in the clear and the database held a full
plaintext copy of their history.

---

## 4. Accounts and keys

Better Auth on D1: email + password, sessions, and a Google provider that is
registered **only when its secret is set** (passing an undefined
`clientSecret` makes Better Auth throw at construction and takes
email/password down with it — the whole API 500s because one optional
provider was half-configured). Google is currently a disabled placeholder.

Three things are unusual, and all three follow from the 10 ms CPU budget:

### 4.1 The server never receives a password

The browser runs **PBKDF2-SHA256 at 600,000 iterations** and sends the
derived value. The server's `hashPassword` is therefore a salted SHA-256,
which is correct rather than lazy: the input is already 256 bits of
high-entropy output and there is nothing left to guess. `looksPreStretched`
rejects anything that is not exactly 43 base64url characters, so a client
that skipped the derivation cannot get a raw password stored under a fast
hash.

### 4.2 The same pass yields the vault key

```
PBKDF2(password, salt = "chat.belayet.co/auth/v1:" + email, 600_000)
        # the salt is a frozen label from the old domain — never change it
        │
        ├── HKDF("auth")  → 43 chars → sent to the server
        └── HKDF("vault") → AES-GCM CryptoKey (non-extractable) → never sent
```

That is why email/password accounts get end-to-end encryption with no extra
passphrase, and why Google accounts cannot: OAuth proves identity and
supplies no key material.

**`APP_SALT` and the iteration count must stay identical to what the Worker
expects. Changing either locks every existing account out.**

### 4.3 Absence of a key is not evidence of an unencrypted account

This caused real data loss once. A device whose IndexedDB had been cleared
still had a valid session cookie, took the "no key" branch, and overwrote the
account's encrypted settings with plaintext defaults — after which the
correct password could no longer open it, because the blob it was asked to
decrypt was no longer ciphertext.

The server's `encryption` field is the authority, never the local key.
`pushRemote` refuses with `WouldDowngradeError`, and `adopt` bails to the
`locked` state first. `locked` has its own UI (`UnlockBar`) because an empty
transcript reads as lost data.

Remembered keys are scoped by account id. A legacy unscoped key is accepted
only long enough to try opening the sealed settings; failure deletes it and
returns to `locked` before any content write can happen. Remembering is the
default, while the synced “lock on exit” preference removes the IndexedDB key
and requires the password again after a refresh.

---

## 5. Never read or write an encrypted account without its key

`assertUnlocked` throws `LockedError` before any request leaves. There is no
persisted pull cursor any more: D1 is authoritative and unlocking starts with
a full thread list. The in-memory revision is only a freshness hint, and local
commits advance it so the browser cannot mistake its own checkpoint for a
remote edit.

---

## 6. The data protocol

### 6.1 One request per turn, one query per read

There is no reconciliation any more. A write is a request, a read is a
request, and what the server returns *is* the state.

- **Reading the sidebar** — `GET /v1/threads`, one indexed query, `ETag` on
  the account revision so an unchanged list comes back as a 304.
- **Opening a thread** — `GET /v1/threads/:id`, two indexed queries. Paged by
  `seq`, resumed from the last seq seen rather than an offset, because the
  server also ends a page early when payloads reach its byte budget: **a short
  page is not the last page.**
- **Writing a turn** — `PUT /v1/threads/:id`, one `batch()`. It can create the
  thread, truncate a tail, and write messages together, because a turn is one
  atomic thing and splitting it would mean a visible half-applied state and
  three round trips on the hottest path in the app.
- **Catching up** — `GET /v1/delta?since=N&thread=ID`. The client holds
  exactly two things, so this answers exactly two questions: which thread rows
  moved, and did anything inside the open thread move. The second is a boolean
  rather than a list, because the client's response either way is to re-read
  the whole thread in one query.

The account still has one monotonic integer `rev`, but its job has shrunk. It
is no longer a cursor whose correctness data depends on; it is a freshness
hint, held in memory, never persisted. Losing it costs one redundant delta.

**Statement order inside the write batch is load-bearing.** Thread upsert
first, so a new thread and its first message land in the same transaction and
the message's `WHERE EXISTS` guard is satisfied. Then the truncate. Then the
inserts — an edit-and-resend truncates from seq 3 and immediately writes a new
message at seq 3, and the other order deletes what it just wrote.

**The revision is allocated inside that batch**, by the `UPDATE … RETURNING`
that is its first statement, with the inserts reading it back through a
subquery. Deriving it from a row read earlier in the request let two devices
write the same revision; fixing that with `UPDATE … RETURNING` but leaving it
a separate statement left a narrower window with the same shape — the revision
visible to a concurrent reader before its rows existed. The same statement
advances the daily write counter, so bounding D1 spend costs no extra round
trip.

**A message insert is guarded by `WHERE EXISTS` on a live thread.** One device
deleting a thread while another streams into it is a real race; without the
guard those rows land pointing at nothing, invisible to every read because
reads go through the thread, and therefore never cleaned up.

**A checkpoint does not touch the thread row.** `touch` is what a streaming
save omits — bumping the thread alongside every checkpoint would double the
rows written for a long answer to announce something no reader needs.

### 6.1a Tombstones are gone

A deletion is a `DELETE`. `thread.deleted` survives only long enough for a
connected device to notice, and is swept lazily inside the next delete's
batch. A device that misses that window needs nothing: it stores nothing, so
its next list simply will not contain the thread.

Under the old design a deletion had to be recorded in a `tombstones` table, or
deleting a conversation on one device looked exactly like that device not
having it yet, and the next pull helpfully restored it.

### 6.2 What a payload is

A thread's `meta` seals its title, model, reasoning effort, search flag and
rolling totals. (The system prompt is the account's instructions, sealed in
the settings blob; threads written before that change still carry a `system`
field nobody reads.) A message's `payload` seals the whole
`UIMessage` — parts, metadata, flight recorder.

There is no `kind` tag any more, because the table says which is which. That
is the trade phase 13 made: the old store could not tell a conversation from a
message, and consequently could not render a sidebar without sending the
entire account to the browser to be decrypted. The structural columns around
the seal — `thread_id`, `seq`, `pinned`, `updated_at`, `deleted` — are what
make a page load one indexed query. `worker/schema-app.sql` states exactly
what they disclose, and §12 states it again in the words the privacy policy
uses.

**`meta` and `payload` are never parsed, indexed, or logged.** Wanting to know
something about a record's contents means the client should send that fact
explicitly, as a deliberate decision to disclose it.

### 6.3 Heavy things go to R2

Two kinds of content do not fit in a 128 KB D1 row:

**Images and attachments.** `prepareBlobs` uploads the bytes and leaves only
a blob id in the record. Blob ids are deterministic — derived from the
message id — so a retry overwrites the same object instead of leaking a new
one, and the Worker can erase every attachment belonging to a deleted opaque
record without decrypting anything:

```
{userId}/{recordId}.{g|f|p}.{partIndex}.{assetIndex}
                     │ │ │
                     │ │ └── p = a spilled record payload
                     │ └──── f = a user attachment (image or PDF)
                     └────── g = a generated image
```

**Oversized payloads.** `sealRecord` base64s the ciphertext — a 4/3
expansion on top of JSON escaping — so the 128 KB server limit is really
about **90 KB of message text**. A long reasoning answer overflowed it, and
because one rejected batch throws, a single message stopped the whole
account's sync. Payloads over 96 KB now spill to R2 behind an `@r2:`
sentinel. The spilled bytes are the *already sealed* payload, so nothing is
encrypted twice and the service learns nothing it did not already hold.

`@` is outside the base64url alphabet and is not `{`, so the sentinel can
never be mistaken for a sealed record or for the plain JSON a keyless account
stores.

### 6.4 Write amplification — the thing that actually cost money

Two bugs made sync roughly **113× more expensive** than it needed to be:

1. `saveTurn` marked the **entire thread** dirty on every save. One turn in a
   fifty-message conversation queued fifty records.
2. The mid-stream snapshot ran that every 1.2 s. A single long answer cost
   ~2,000 D1 row writes — about fifty answers a day before the free tier was
   gone.

Both are fixed:

- **`saveTurn` only rewrites what changed**, compared with a cheap
  `contentKey`. This also preserves the R2 blob references the sync engine
  writes back into those rows, which is what stopped images being
  re-uploaded for ever.
- **The cloud checkpoint is the durability clock.** `ChatView` offers the
  current stream every 1.2 s; `saveTurn` writes the first useful checkpoint
  immediately and throttles later ones to 5 s. Closing a tab therefore loses
  about a second early in a turn and at most five seconds later in one.
- **Writes are serialized per thread.** Sealing and R2 spilling are async. A
  half-answer checkpoint previously could arrive after the final save and win
  simply because it was last; the per-thread promise chain makes arrival order
  equal transcript order, and `onFinish` closes the draft interval
  synchronously so a late timer cannot queue after the final answer.

`contentKey` hashes text **in full** — keying on length would have silently
skipped an edit that preserved it ("Hello there" → "Hello Peter") — but reads
only the *size* of attachments. Hashing megabytes of base64 every 1.2 s would
cost more than the writes it saves, and reaching into those parts would pick
up the very blob ids that must not count as a change.

### 6.5 Getting a remote change onto the screen

For a while the rail refreshed and the open transcript did not — which is the
entire reason cross-device sync *looked* broken while it was working
perfectly.

The delta now returns the changed thread rows themselves, so the rail is
patched in place rather than re-queried, and `pulled` increments **only** when
the delta says the *open* thread moved. A write to some other conversation
must not make the transcript in front of the reader re-read itself.

`ChatView` now adopts remote changes, with four guards, each protecting
local work:

1. **Never while busy or while a save is pending.** The stream and its final
   unsaved snapshot are authoritative; the version is re-checked when both
   settle.
2. **Never after a failed save.** The complete in-memory answer stays visible
   until retry succeeds instead of being replaced by the last cloud draft.
3. **Never twice for the same version.** This keeps the dependencies
   from re-reading the instant a stream finishes and racing the `onFinish`
   save that has not landed yet.
4. **Never when the stored copy is missing a message this device never
   wrote.** That is this device's own unsaved work. A missing message the
   server *did* hold — `loadThread` reports those as `removed` — was deleted
   on another device by an edit or a regenerate, and that applies here too.

Reads are incremental. The store keeps the open thread's decrypted messages
with the revision each was read at, asks the server only for rows that moved
since (`GET /v1/threads/:id?since=`; every row still comes back as id, seq and
revision, which is how a deletion shows), and hands back the *same objects*
for everything else — so a remote change re-decrypts, re-downloads and
re-renders only what moved. Decryption and R2 reads run six at a time.

---

## 7. Realtime

One **hibernating Durable Object per account** (`worker/src/live.ts`). It
never sees a record, title, prompt, or blob id in the clear — a sync commit
sends the latest integer revision, and connected devices use it as a hint to
run the normal authenticated pull. So a dropped socket message cannot lose data; it
only delays a refresh until the next focus or interval.

Hibernatable sockets keep the connection alive while the object sleeps, so
idle accounts consume no Durable Object time.

**The hub never echoes a revision to the device that caused it.** Each socket
registers a connection id as a DO *tag* (tags survive hibernation), pushes
carry that id, and the fan-out skips it. Without this, a device pushing
mid-stream woke itself, found the rows its own 1.2 s snapshot had just
re-dirtied, pushed again, and looped at round-trip speed.

**Live frames mirror a reply while it streams.** Checkpoints reach D1 every
~5 s, which is what another device used to see: an answer arriving in jumps.
Now the streaming device also publishes the turn's tail — the messages from
its user message on — over the same socket about five times a second: a
keyframe first, then patches that are almost entirely appended text (a few
hundred bytes each, `lib/live-frames.ts`). Frames are sealed with the vault
key and bound to their thread, stream and number; the hub reads only the
envelope (`t`, `thread`) and relays the original string to the account's
other sockets, storing nothing. A device with the thread open lays the tail
over its transcript (checking the message before it, `prev`, so a tail is
never attached to the wrong history) and renders it with the same live
activity UI. An edit or regenerate moves the tail's `base` back, so a
truncation made elsewhere also applies live. A receiver that joins mid-stream
or misses a frame asks for a keyframe (`want`); the other device's Stop is a
`stop` message; a stream that goes quiet for 12 s without its `done` frame
falls back to the last checkpoint. The hub announces how many sockets are
connected (`peers`), and a device alone on its account publishes nothing.

**Settings are live too.** A settings write names the writer's socket and
whether a shared field changed; the hub tells the other devices, which re-read
the blob and take everything except their own device fields (open thread,
rail geometry, the remember-key choice).

**The close handler must not echo reserved codes.** `close()` rejects 1005 and
1006, and 1006 is exactly what an abrupt disconnect delivers. Throwing in a
hibernation handler is not a local failure — it tears down the object, which
drops the sockets every *other* device on the account is holding.

---

## 8. Storage quota

R2 has no per-prefix quota and no cheap way to ask how much a prefix holds,
so the running total lives in D1: `user_state.blob_bytes` / `blob_count`,
maintained on every put and delete.

- Default ceiling **250 MB per account**, overridable with
  `BLOB_QUOTA_BYTES`. Over it, uploads are refused with **507**.
- The put path subtracts the **previous** object's size first. Blob ids are
  deterministic, so a re-sync overwrites rather than adds; counting that as
  new would exhaust the quota while occupying one object's worth of space.
- Deletes decrement, clamped with `MAX(0, …)` — an underflow would be
  permanent, since there is no reconciliation pass.
- Accounts predating the counters **backfill themselves** from a single
  prefix list the first time settings is opened.

`GET /v1/state` reports bytes, object count, quota and record count; the
settings panel draws it as a monochrome bar. There is no colour vocabulary in
this interface to borrow for "nearly full", so it says so in words.

### 8.1 The D1 side of the same idea

R2 needed a ceiling and got one. D1 needed one too and did not have it: every
other limit in the Worker is per request, which bounds a single push and
nothing cumulative, so one authenticated client looping a write could spend
the deployment's entire daily row-write allowance in minutes.

`user_state.writes_day` / `writes_today` are a per-day counter, reset lazily by
comparing the stored day to today's. They are advanced by the **same** UPDATE
that allocates the revision, and enforced against the state row the request has
already loaded — so the ceiling costs no extra statement, no extra round trip
and no extra CPU. Default **10,000 rows per account per day**, overridable with
`DAILY_WRITE_LIMIT`; over it, pushes are refused with **429**. A long streaming
answer costs about twenty rows, so nothing legitimate comes close.

Enforcing against the already-loaded row lets a burst overshoot by at most one
push. That is the right trade for a spend guard: the alternative is a D1 round
trip on the hottest write path to make a number nobody reaches exact.

---

## 9. Inference, in the browser

`lib/transport.ts` is a hand-rolled AI SDK v7 `ChatTransport` running
`streamText` in the tab. It is the old `app/api/chat/route.ts`, same work in
the same order, minus the parts that only protected a server.

> `DirectChatTransport` looks like the answer and isn't: its generic is
> `UIMessage<unknown, never, …>` and the `never` is the data-parts slot —
> this app has two (`data-image`, `data-requestStatus`). It also wants a
> fixed `Agent`, while model/effort/search change per turn.

**The transport takes refs, not values.** It is built once per conversation
with `useMemo(…, [])`, so a captured settings object would send the previous
model on the turn right after a switch — and a closure reading `.current`
during render trips `react-hooks/refs`. Passing the ref *object* solves both.
Capabilities are passed the same way, for the same reason.

Supporting modules: `lib/catalog.ts` (model list, cached an hour),
`lib/capabilities.ts` (resolves what controls may be offered — a control is
only shown when the model will actually honour it), `lib/credentials.ts` +
`lib/pkce.ts` (the user's key, via OpenRouter OAuth PKCE or paste).

### PDFs

A document is an ordinary `file` part. The provider encodes it as
`{type:"file", file:{filename, file_data}}` and OpenRouter reads it — nothing
touches our infrastructure.

`pdfEngineFor` picks:

- **`native`** when the catalog advertises `file` input — the model sees real
  pages, layout and figures intact, billed as ordinary input tokens.
- **`cloudflare-ai`** otherwise — converts to markdown, free.

The engine is **always** stated. OpenRouter's own default is `mistral-ocr` at
**$2 per 1,000 pages**, and nobody should be billed for OCR they did not ask
for, so it is never selected automatically.

Attachments are no longer gated on `vision`: an image needs an image model, a
PDF does not.

---

## 10. Worker API

All under `/v1/` on the same origin as the app — no CORS preflight, no
cross-site cookie configuration.

| Route | Method | Notes |
|---|---|---|
| `/v1/auth/*` | — | Better Auth. Rate limited; see below. |
| `/v1/threads` | GET | the sidebar. `ETag` = account rev, so an unchanged list is a 304 |
| `/v1/threads/:id` | GET | thread + messages by `seq`; paged by row count *and* a byte budget |
| `/v1/threads/:id` | PUT | one turn: optional `meta`, optional `truncateFrom`, ≤50 messages, one `batch()` |
| `/v1/threads/:id` | DELETE | soft-delete thread, hard-delete messages, sweep old tombstones, purge the R2 prefix |
| `/v1/delta` | GET | `?since=N&thread=ID` → changed thread rows + "did the open thread move" |
| `/v1/state` | GET | settings blob, encryption mode, usage |
| `/v1/state` | PUT | replace settings; `encryption` may never move back to `none` |
| `/v1/blobs/:id` | PUT / GET / DELETE | quota-enforced; id must match `BLOB_ID` (two segments: `<thread>/<message>.…`) |
| `/v1/live` | GET (upgrade) | websocket to the account's Durable Object |
| `/v1/me` | DELETE | erase the D1 identity, then the R2 prefix in `waitUntil` |

**Account state is loaded per route, not up front.** Every request used to pay
`getSession` + `loadState` before the router had looked at the path, so a 404
and a WebSocket upgrade cost the same D1 read as a write did. Fetching an
image is now one R2 get and no D1 at all — which is exactly the request a page
full of generated images repeats.

**`MAX_MESSAGES_PER_WRITE × MAX_PAYLOAD_CHARS` must stay under
`MAX_BODY_BYTES`.** The old pair did not: 100 records at 128 KB was 12.8 MB
against an 8 MB body cap, so a batch satisfying every documented per-record
limit could still be rejected — with the wrong status and a message about body
size rather than the 413 the limits promised. 50 × 128 KB = 6.4 MB now.
Changing either number means re-checking this relationship.

**A cookie-cached session outlives the account it belongs to.** Sessions are
read from a signed cookie for five minutes, so a deleted user's cookie stays
cryptographically valid. `loadState` returns null when the user row is gone
and the router turns that into a 401 — without it the request hit a
foreign-key violation and 500'd, which is a deleted account failing *open*.

Rate limits (Better Auth's own, D1-backed so counters are global across
isolates, keyed on `cf-connecting-ip`):

- `/sign-in*`, `/sign-up*`, `/change-password*`, `/change-email*` — 3 per 10 s
- OTP send, password reset — 3 per 60 s
- everything else under `/v1/auth` — 100 per 60 s

**Nothing outside `/v1/auth` is rate limited per unit time.** The daily
row-write ceiling (§8.1) bounds cumulative D1 spend, which is the thing that
actually costs money, but there is still no per-second limit on the data
routes. See §14.

---

## 11. Data model

**D1 — Better Auth:** `user`, `session`, `account`, `verification`,
`rateLimit`.

> Never hand-write the auth schema. `node worker/gen-schema.mjs >
> schema-auth.sql` derives it from the same `createAuth` the Worker runs. The
> deprecated standalone CLI resolved to 1.4.21 against a 1.7.1 runtime,
> omitted `account.issuer`, and every signup 500'd with a SQLITE_ERROR buried
> in the logs. Regenerate after any auth-option change or version bump.

**D1 — app** (`worker/schema-app.sql`):

```sql
user_state(user_id PK, rev, encryption, settings, updated_at,
           blob_bytes, blob_count, writes_day, writes_today)

thread(user_id, id, rev, meta, pinned, deleted, created_at, updated_at,
       PRIMARY KEY (user_id, id))
CREATE INDEX thread_list ON thread(user_id, deleted, pinned DESC, updated_at DESC);
CREATE INDEX thread_rev  ON thread(user_id, rev);

message(user_id, id, thread_id, seq, rev, payload, updated_at,
        PRIMARY KEY (user_id, id))
CREATE INDEX message_thread ON message(user_id, thread_id, seq);
CREATE INDEX message_rev    ON message(user_id, rev);
```

`meta` and `payload` are sealed. Everything else is in the clear, and is in
the clear on purpose: sorting and grouping cannot be done through a seal.
`thread_list` leads with `(user_id, deleted)` so the sidebar query and the
settings count are index ranges rather than scans — the equivalent COUNT on
the old `record` table could not use its index for the `deleted` predicate and
read every row on the account.

There is no `deleted` column on `message`. A truncation hard-deletes the tail
and bumps the owning thread's `rev`, which is what tells a live device to
re-read. A soft delete would buy nothing, because the client cannot be holding
a stale copy of a message it never persisted.

`encryption` is one of `none` | `password` | `passphrase`.

**R2:** keys as in §6.3. Objects carry a 6-byte envelope — magic `DIAL`,
version, mode (`0` plain / `1` AES-GCM) — then a 12-byte IV and ciphertext.
The blob id is bound in as AES-GCM additional authenticated data, so moving
ciphertext to another key fails to decrypt rather than displaying the wrong
image.

---

## 12. What the operator can and cannot see

**Cannot**, for an email/password account: message text, conversation titles,
system prompts, reasoning traces, model choices, images, attachments, the
OpenRouter key, or any setting.

**Can**: that an account exists, its email, name, date of birth, session and
IP metadata — and, since phase 13, the *shape* of the account's usage: how
many conversations it has, how many messages are in each, their order, when
each was last touched, which are pinned, and how large each sealed payload is.

That last group is a genuine widening and it was a deliberate trade. The
opaque store disclosed strictly less, and cost a full download-and-decrypt of
the account to render a sidebar. The privacy policy states the new boundary in
these words rather than claiming we see nothing: **a complete database dump
shows that you had a conversation, and nothing about what it was.**

**E2EE means our server cannot read it — not that nobody can.** OpenRouter
and the upstream provider see every prompt in the clear. Say it that way; the
privacy policy does.

---

## 13. Build, deploy, operate

```bash
npx next build          # static export to ./out
npx wrangler deploy     # Worker + assets, one origin
```

```bash
# schema (idempotent; the auth file is generated, never hand-edited)
npx wrangler d1 execute chat-vault --remote --file worker/schema-app.sql
node worker/gen-schema.mjs > worker/schema-auth.sql
```

Secrets are `wrangler secret put` only: `AUTH_SECRET`, `DATA_KEY`, and
`GOOGLE_CLIENT_SECRET` when Google is enabled. The Google **client id** is
public by design and lives in `wrangler.jsonc` vars.

**There are no frontend environment variables.** Not "none required" — none
at all. The OpenRouter key belongs to the user and lives in their browser.

Security headers ship in `public/_headers` (a static export has no
`headers()`). The load-bearing directive is `connect-src 'self'
https://openrouter.ai`: the user's key lives in the browser, so the realistic
threat is script injection exfiltrating it, and exfiltration needs a
destination.

---

## 14. Known gaps

- **No rate limit outside `/v1/auth` per unit time.** The data routes are
  bounded per request and per account per day (§8.1), but not per second.
- **There is no offline mode, at all.** This is a deliberate consequence of
  §3, not an oversight, but it is a real capability loss: no network means no
  app. Inference is browser-to-OpenRouter direct, so a Worker outage stops
  *persistence* rather than the answer — `ChatView` shows a "not saved" notice
  with a retry, and the reply on screen is the only copy until it lands.
- **Orphaned R2 objects from the phase-13 reset.** Three objects written under
  the old per-message key scheme are unreachable by the thread-prefixed one.
  The counters were zeroed so the quota readout is honest about what the app
  can see, and the self-heal that would have re-measured them was removed —
  but roughly 1.5 MB of undecryptable ciphertext still occupies the bucket.
  Clearing it needs a bucket-level delete.
- **A PDF is re-parsed on every turn of its thread.** `hasPdf` is true for the
  whole conversation, so the file-parser plugin runs again on each message.
  Free on `native` and `cloudflare-ai`, but it is latency on every turn;
  OpenRouter's documented fix is to cache the returned annotations and send
  those back instead of the file.
- **Signup costs 44 ms CPU**, 4.4× the free-tier limit. Not throttled so far;
  watch for 1027s.
- **Email OTP is wired but inert.** `createAuth` gates both
  `requireEmailVerification` and the whole `emailOTP` plugin on
  `Boolean(env.EMAIL && env.EMAIL_FROM)`, and neither binding is configured,
  so turning it on is configuration rather than code. Two things to know
  first: Cloudflare Email Service requires the **Workers Paid** plan to send
  to arbitrary recipients (free sends only to verified destination addresses),
  and the moment both bindings exist `requireEmailVerification` flips on and
  locks out every account whose `emailVerified` is still 0 — backfill that
  column before adding the binding, not after.
- **Google is a disabled placeholder** — no secret set, no redirect URI
  registered.
- **R2 custom domain** (`BLOB_PUBLIC_ORIGIN` + CORS) would remove Worker
  invocations for ciphertext reads. Authenticated Worker reads are the
  current fallback.
- **Selection painting across block boundaries** draws full-width bands.
  Within a message every gesture paints tight to the glyphs; `user-select`
  and per-element `::selection` were both measured and neither fixes the
  cross-block case.

---

## 15. Rules that cost something to learn

The full list lives in `CLAUDE.md` under *Rules learned the hard way* — it is
the project's law and worth reading before touching scroll, sync, or layout.
The three that recur:

1. **Diagnose by bisecting the actual page, not by mechanism-that-could-
   explain-it.** Two deploys went out "fixing" a Safari scroll bug that was
   actually `container-type: inline-size` on the scroller's parent silently
   applying layout containment.
2. **Measure before believing.** `getClientRects()` reports rectangles the
   browser never paints; `wrangler tail` reports the CPU your reasoning
   predicted wrong.
3. **A store is not React.** Anything written behind React's back needs an
   explicit signal, or it exists and is invisible. This was about Dexie; it is
   now about the delta, and the rule survived the store it was learned on.
4. **Two copies of the truth cost more than the feature they enable.** Every
   silent data loss in this project came from reconciling a local store with
   a remote one, and each fix was correct and revealed the next one. Phase 13
   deleted the second copy instead. When something proposes bringing it back
   — for offline, for speed — the question to answer first is not "how do we
   cache this" but "what happens when the two disagree".

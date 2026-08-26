# How this codebase works

A chat interface for every model OpenRouter serves, with accounts and
cross-device sync, that costs the operator **nothing to run**.

That last clause is not a nice-to-have. It is the constraint that explains
almost every structural decision below, and most of the surprising ones only
make sense once you hold it in mind: *no byte we pay for sits in the token
path, and nothing unbounded is billable.*

---

## 1. The shape of the system

There are three programs and three stores.

```
   Browser (the whole app)                    Cloudflare
  ┌─────────────────────────────┐            ┌──────────────────────────┐
  │  Next.js static export      │            │  Worker  (chat.belayet.co)│
  │                             │            │   /v1/auth/*   Better Auth│
  │  ┌───────────────────────┐  │  session   │   /v1/sync     records    │
  │  │ inference (streamText)├──┼──cookie───▶│   /v1/state    settings   │
  │  └───────┬───────────────┘  │            │   /v1/blobs/*  bytes      │
  │          │ user's own key   │            │   /v1/live     websocket  │
  │          ▼                  │            │   /v1/me       delete     │
  │   openrouter.ai  ◀──────────┼────────────┼──(never)                  │
  │                             │            └────┬────────┬────────┬────┘
  │  ┌───────────────────────┐  │                 │        │        │
  │  │ Dexie (IndexedDB)     │  │                 ▼        ▼        ▼
  │  │ source of truth       │  │                D1       R2    Durable
  │  └───────────────────────┘  │            (records) (bytes)  Object
  └─────────────────────────────┘                                (fanout)
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

**The Worker is the only server, and it cannot read what it stores.**

---

## 2. Where the money would go, and why it doesn't

| Surface | Free allowance | What we do about it |
|---|---|---|
| Static assets | unmetered | The entire frontend. Never invokes the Worker. |
| Model inference | — | User's key, browser→OpenRouter. Operator cost is structurally zero. |
| Worker CPU | 10 ms/request | Password stretching moved to the browser; sessions read from a signed cookie for 5 min. |
| D1 rows written | 100k/day | Only changed messages are pushed; streaming pushes are throttled. See §6.4. |
| D1 rows read | 5M/day | One indexed lookup per sync. |
| R2 storage | 10 GB | **Per-account quota**, §8. The only cumulative surface. |
| Durable Objects | SQLite-backed, free tier | Hibernating sockets; idle accounts consume nothing. |

Measured on the deployed Worker with `wrangler tail`:

```
/v1/sync   GET     2 ms CPU
/v1/sync   POST    1 ms CPU
/v1/me     DELETE  6 ms CPU
/v1/auth/sign-up   44 ms CPU   ← 4.4x the free-tier limit, not throttled
```

Signup is the one outlier. It is Better Auth's own work plus D1 writes plus
the database-backed rate limiter, not instance construction — caching the auth
instance per isolate was tried and did not move it.

---

## 3. Three stores, and which one is the truth

**Dexie (IndexedDB) is the source of truth.** The cloud is a replica of it,
never the other way round. The app is fully usable with no account; anything
that turns sync into a login wall is a regression.

| Store | Holds | Readable by us? |
|---|---|---|
| Dexie | conversations, messages, tombstones, vault key | n/a — it is the user's device |
| D1 `record` | one opaque payload per conversation/message | **No** for password accounts |
| D1 `user_state` | settings blob, encryption mode, revision, storage totals | Settings blob is always encrypted |
| R2 | images, attachments, spilled payloads | **No** for password accounts |

Dexie schema is at **v4** (`lib/db.ts`):

- `conversations` — id, updatedAt, pinned, dirty
- `messages` — id, conversationId, `[conversationId+seq]`, dirty
  (IndexedDB guarantees no insertion order, so thread order is stored)
- `tombstones` — deletions not yet pushed
- `vault` — the non-extractable `CryptoKey`; the token itself is never stored

Every synced row carries three local-only columns that never leave:
`dirty` (needs pushing), `stamp` (a monotonic write marker), `rev` (the
server revision it came from).

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

---

## 5. Never sync an encrypted account without its key

`runSync` throws `LockedError`. An earlier version pulled ciphertext, failed
to read every record, and **still advanced the cursor past all of it** —
leaving a signed-in user with an empty history sitting above a revision the
device would never ask for again. `unlock` also calls `clearCursor()`,
because regaining a key means you do not know what you missed.

---

## 6. The sync protocol

### 6.1 Revisions and the cursor

Every account has one monotonic integer `rev`. Pulling means "give me
everything above N"; pushing means "here are rows, stamp them". No vector
clocks, no CRDTs, no merge UI — messages are append-only and the only mutable
object is a conversation's own metadata being edited by one person across
their own devices.

**Order matters: pull, then push.** Applying the server's view first and
writing local changes over it is what makes a local edit win on the device
being typed on.

**Revisions are allocated by the database**, not derived from a read:

```sql
UPDATE user_state SET rev = rev + 1, updated_at = ? WHERE user_id = ? RETURNING rev
```

Computing `state.rev + 1` from a row read earlier in the request meant two
devices pushing at once wrote the same revision — and a third device that
pulled between the two writes advanced its cursor past it and never asked for
the second batch again. Silent loss. Realtime is what turned this from
theoretical into routine, by making two devices online at once normal.

**`PAGE_SIZE` (250) must stay strictly greater than `MAX_PUSH_RECORDS`
(100).** The cursor advances to the last row's revision, so every record
sharing a revision has to fit in one page or the remainder is unreachable for
ever. One push allocates one revision and carries at most 100 records, so 100
is the largest possible group and the gap is the safety margin.

### 6.2 What a payload is

```
Envelope = { kind: "conversation", data } | { kind: "message", data }
```

The `kind` tag lives **inside** the ciphertext rather than in a column, so
the database cannot tell a conversation from a message. It holds an opaque
string under an opaque id and nothing more. `worker/schema-app.sql`
deliberately has no `kind` column, no parent id, no sequence number, no
title — a full database dump reveals account count, record count, and record
sizes.

**`payload` is never parsed, indexed, or logged.** Wanting to know something
about a record's contents means the client should send that fact explicitly,
as a deliberate decision to leak it.

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
- **Local durability and cloud freshness are different clocks.** The snapshot
  stays at `STREAM_SAVE_MS` (1.2 s) — that is what stops a closed tab losing
  a long answer, and it is a *local* concern. Pushing to D1 at that rate is a
  separate question: `DRAFT_SYNC_MS` (5 s) throttles streaming pushes, which
  still reads as live on another device.

`contentKey` hashes text **in full** — keying on length would have silently
skipped an edit that preserved it ("Hello there" → "Hello Peter") — but reads
only the *size* of attachments. Hashing megabytes of base64 every 1.2 s would
cost more than the writes it saves, and reaching into those parts would pick
up the very blob ids that must not count as a change.

### 6.5 Getting a pull onto the screen

`applyRecords` writes straight into Dexie, and Dexie is not React. For a
while the rail refreshed (it reloads when a sync settles) and the open
transcript did not — which is the entire reason cross-device sync *looked*
broken while it was working perfectly.

`ChatView` now adopts remote changes, with three guards, each protecting
local work:

1. **Never while busy.** A stream in progress is authoritative; the version
   is re-checked when it settles.
2. **Never twice for the same version.** This keeps the `busy` dependency
   from re-reading Dexie the instant a stream finishes and racing the
   `onFinish` save that has not landed yet.
3. **Never when the stored copy is missing a message we are holding.** That
   means our own save is still in flight and the read is stale.

The cost of guard 3 is that a *truncation* made on another device (an edit or
a regenerate) waits for a thread switch rather than applying live. Losing a
locally streamed answer would be far worse.

---

## 7. Realtime

One **hibernating Durable Object per account** (`worker/src/live.ts`). It
never sees a record, title, prompt, or blob id — a sync commit sends the
latest integer revision, and connected devices use it as a hint to run the
normal authenticated pull. So a dropped socket message cannot lose data; it
only delays a refresh until the next focus or interval.

Hibernatable sockets keep the connection alive while the object sleeps, so
idle accounts consume no Durable Object time.

**The hub never echoes a revision to the device that caused it.** Each socket
registers a connection id as a DO *tag* (tags survive hibernation), pushes
carry that id, and the fan-out skips it. Without this, a device pushing
mid-stream woke itself, found the rows its own 1.2 s snapshot had just
re-dirtied, pushed again, and looped at round-trip speed.

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
| `/v1/sync` | GET | `?since=N` → records above N, page of 250 |
| `/v1/sync` | POST | ≤100 records, ≤128 KB payload each; allocates one revision |
| `/v1/state` | GET | settings blob, encryption mode, usage |
| `/v1/state` | PUT | replace settings; `encryption` may never move back to `none` |
| `/v1/blobs/:id` | PUT / GET / DELETE | quota-enforced; id must match `BLOB_ID` |
| `/v1/live` | GET (upgrade) | websocket to the account's Durable Object |
| `/v1/me` | DELETE | erase account, records, settings, and the R2 prefix |

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

**Nothing outside `/v1/auth` is rate limited.** See §14.

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
           blob_bytes, blob_count)
record(user_id, id, rev, deleted, payload, PRIMARY KEY (user_id, id))
CREATE INDEX record_cursor ON record(user_id, rev);   -- the only query shape
```

`encryption` is one of `none` | `password` | `passphrase`.

**R2:** keys as in §6.3. Objects carry a 6-byte envelope — magic `DIAL`,
version, mode (`0` plain / `1` AES-GCM) — then a 12-byte IV and ciphertext.
The blob id is bound in as AES-GCM additional authenticated data, so moving
ciphertext to another key fails to decrypt rather than displaying the wrong
image.

---

## 12. What the operator can and cannot see

**Cannot**, for an email/password account: message text, titles, prompts,
reasoning traces, images, attachments, the OpenRouter key, or anything about
a record beyond its id, size and revision.

**Can**: that an account exists, its email, name, date of birth, session and
IP metadata, how many records it has, how large they are, and when they
changed.

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

- **No rate limit outside `/v1/auth`.** `/v1/sync`, `/v1/state`, `/v1/blobs`
  and `/v1/live` are bounded per request but not per unit time.
- **Signup costs 44 ms CPU**, 4.4× the free-tier limit. Not throttled so far;
  watch for 1027s.
- **Email OTP is wired but inert.** Two blockers before switching it on:
  Cloudflare's `send_email` binding cannot reach arbitrary addresses until a
  sending domain is onboarded, and `requireEmailVerification` would lock out
  every existing account until `emailVerified` is backfilled.
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
3. **Dexie is not React.** Anything written behind React's back needs an
   explicit signal, or it exists and is invisible.

-- Application tables, layered on Better Auth's `user` / `session` /
-- `account` / `verification`.
--
-- This file is idempotent and safe to re-run.
--
-- It briefly was not. Step 2 had its own `account` and `credential` tables
-- for token identity, and this file dropped them so Better Auth could take
-- `account` over as its OAuth-provider link table. That migration has run;
-- the DROPs are gone, because re-running them now would delete Better
-- Auth's account table and disconnect every Google login from its user.

-- ---------------------------------------------------------------------------
-- Per-user account state: revision counter, encryption mode, settings blob,
-- and the two spend ceilings.
-- ---------------------------------------------------------------------------
--
-- `encryption` records how this account's payloads are protected:
--   'none'       — server-readable. The default for Google sign-in, which
--                  supplies no key material.
--   'password'   — the KEK falls out of the same client-side PBKDF2 pass
--                  that produced the auth credential. Free, no extra
--                  passphrase, and available to every email/password account.
--   'passphrase' — a separate secret the user types per device. The only
--                  option that gives a Google account real E2EE.
--
-- `settings` is one blob: theme, typeface, layout, the session defaults, the
-- rail geometry, the last open thread, and the OpenRouter key. It is always
-- encrypted — under the user's KEK when `encryption` is not 'none', and under
-- the server-held DATA_KEY otherwise. An OpenRouter key is a billable
-- credential and must never sit in this database in the clear.
--
-- It carries more than it used to. The browser no longer keeps durable state,
-- so anything that outlives a tab lives here; a preference set on the laptop
-- is on the phone at the next load, which is the point.
--
-- `rev` is the account's monotonic revision counter, allocated by the same
-- UPDATE that writes rows (see `allocate` in index.ts). Every thread and
-- message row carries the revision it was last written at, which is what
-- makes "what changed since N" one indexed range scan.
--
-- `blob_bytes` / `blob_count` are a running total of what this account holds
-- in R2, maintained on every put and delete. R2 has no per-prefix quota and
-- no way to ask "how much does this prefix hold" without listing it, so the
-- number has to be carried here — listing a prefix on every upload would put
-- an unbounded operation on the hot path.
--
-- `writes_day` / `writes_today` are the D1 side of the same idea: a per-day
-- row-write counter, reset lazily by comparing the stored day to today's.
-- It is advanced by the same UPDATE that allocates a revision, so bounding
-- D1 spend costs no extra statement and no extra CPU.
CREATE TABLE IF NOT EXISTS user_state (
  user_id      TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  rev          INTEGER NOT NULL DEFAULT 0,
  encryption   TEXT NOT NULL DEFAULT 'none',
  settings     TEXT,
  updated_at   INTEGER NOT NULL,
  blob_bytes   INTEGER NOT NULL DEFAULT 0,
  blob_count   INTEGER NOT NULL DEFAULT 0,
  writes_day   INTEGER NOT NULL DEFAULT 0,
  writes_today INTEGER NOT NULL DEFAULT 0
);

-- One-time migration for databases created before the quota existed. SQLite
-- has no ADD COLUMN IF NOT EXISTS, so these are deliberately kept out of the
-- idempotent block above; running them twice reports "duplicate column name"
-- and changes nothing.
--
--   ALTER TABLE user_state ADD COLUMN blob_bytes INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE user_state ADD COLUMN blob_count INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE user_state ADD COLUMN writes_day INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE user_state ADD COLUMN writes_today INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- What the server can and cannot see
-- ---------------------------------------------------------------------------
--
-- Until now this database was deliberately structureless: one `record` table,
-- an opaque payload, and no way to tell a conversation from a message. That
-- was the right shape while the browser held the truth and this was a replica
-- of it — the server only had to move bytes.
--
-- It is the wrong shape now that the server *is* the truth. Rendering a
-- sidebar meant downloading and decrypting every record on the account, on
-- every page load, because nothing here could be sorted or grouped. So the
-- structure is now explicit, and the trade is stated rather than implied:
--
--   In the clear:  which messages belong to which thread, how many there are,
--                  their order, when each was last touched, which threads are
--                  pinned, and which are deleted.
--   Still sealed:  every title, every message, every system prompt, every
--                  model id, and every setting.
--
-- Ids are client-generated random strings, so they name nothing on their own.
-- A full dump of this database reveals the *shape* of someone's usage and
-- none of its content. That is a real disclosure and the privacy copy says so
-- in those words; it is not described as "we can't see anything".
--
-- The rule that has not changed: `meta` and `payload` are opaque to every
-- endpoint in this Worker. Nothing parses them, indexes them, or logs them.
-- Wanting to know something about a record's contents means the client should
-- send that fact explicitly, as a deliberate decision to disclose it — it is
-- never a reason to look inside.

-- One row per conversation.
--
-- `meta` seals the title, model, reasoning effort, search flag, system
-- prompt, rolling cost/token totals, and whether the title was generated.
-- `pinned` and `updated_at` are in the clear because they are the ORDER BY —
-- sorting is the one thing that cannot be done through the seal.
--
-- `deleted` is a soft delete, and it exists only to serve the realtime delta
-- window. A device that misses the notification does not need it: nothing is
-- stored locally any more, so the next full list simply will not contain the
-- thread. Rows are therefore purged on a short horizon (see PURGE_AFTER_MS),
-- lazily, inside the batch that deletes the next thread.
CREATE TABLE IF NOT EXISTS thread (
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  meta       TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- The sidebar query, exactly: this user's live threads, pinned first, newest
-- first. `deleted` leads the sort columns so it can be an equality predicate
-- rather than a filter applied after the scan — the old COUNT could not use
-- its index for precisely that reason and read every row on the account.
CREATE INDEX IF NOT EXISTS thread_list
  ON thread(user_id, deleted, pinned DESC, updated_at DESC);

-- The delta query: thread rows written since a given revision.
CREATE INDEX IF NOT EXISTS thread_rev ON thread(user_id, rev);

-- One row per message.
--
-- `seq` is the message's position in its thread, assigned by the client as
-- the index in the array it is holding. IndexedDB's lack of insertion order
-- is what originally forced it to be explicit; it stays explicit here because
-- it is now the ORDER BY, and because edit/regenerate rewrites a tail of the
-- thread and needs a range to delete.
--
-- There is no `deleted` column. A truncation hard-deletes the tail and bumps
-- the owning thread's `rev`, which is what tells a live device to re-read the
-- thread. A soft delete would buy nothing: the client cannot be holding a
-- stale copy of a message it never persisted.
CREATE TABLE IF NOT EXISTS message (
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  payload    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- Reading a thread, and truncating one: both are a range over (thread, seq).
CREATE INDEX IF NOT EXISTS message_thread ON message(user_id, thread_id, seq);

-- The delta probe: "has anything in the thread this device has open moved
-- since revision N?" Answered with LIMIT 1 — the endpoint returns a boolean,
-- not a list, because the client's response either way is to re-read the
-- whole thread in one indexed query.
CREATE INDEX IF NOT EXISTS message_rev ON message(user_id, rev);

-- ---------------------------------------------------------------------------
-- Retired: the opaque record store
-- ---------------------------------------------------------------------------
--
-- `record` held both conversations and messages as untyped payloads under a
-- shared (user_id, id) key, with `record_cursor(user_id, rev)` as its only
-- index. It is superseded by `thread` and `message` above.
--
-- Dropping it is destructive and was an explicit decision — the alternative,
-- a client-side migration, was considered and declined. It cannot be done on
-- the server at all: the payloads are sealed, so nothing here can tell which
-- record was a message or which thread it belonged to. Only a signed-in
-- browser holding the key could have re-shaped them.
--
-- The index goes first; SQLite drops it with the table, but being explicit
-- keeps this readable as a migration rather than as a schema.
DROP INDEX IF EXISTS record_cursor;
DROP TABLE IF EXISTS record;

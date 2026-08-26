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

-- Per-user sync cursor, encryption mode, and settings.
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
-- `settings` is one blob: theme, font, layout, and the OpenRouter key. It is
-- always encrypted — under the user's KEK when `encryption` is not 'none',
-- and under the server-held DATA_KEY otherwise. An OpenRouter key is a
-- billable credential and must never sit in this database in the clear.
CREATE TABLE IF NOT EXISTS user_state (
  user_id    TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL DEFAULT 0,
  encryption TEXT NOT NULL DEFAULT 'none',
  settings   TEXT,
  updated_at INTEGER NOT NULL
);

-- One row per synced object (a conversation's metadata, or one message).
-- `payload` is opaque to the sync endpoints regardless of `encryption` —
-- they move bytes and never parse them.
CREATE TABLE IF NOT EXISTS record (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id      TEXT NOT NULL,
  rev     INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  PRIMARY KEY (user_id, id)
);

-- The only query shape sync issues: rows for this user above this revision.
CREATE INDEX IF NOT EXISTS record_cursor ON record(user_id, rev);

# Chat

A minimal, local-first OpenRouter client with optional encrypted account sync.

The frontend is a static Next.js export. Model inference, catalog requests,
search, vision, and image generation go directly from the browser to
OpenRouter using the user’s own key. Cloudflare serves the static files and
runs the small account/sync surface: Better Auth on D1, encrypted image blobs
in R2, and realtime revision signals through hibernating Durable Objects.

Live: [chat.belayet.co](https://chat.belayet.co)

## Product principles

- Local-first. Dexie/IndexedDB is the working source of truth; cloud sync is
  an optional replica, and the app remains usable without an account.
- Bring your own key. The operator never holds or proxies an OpenRouter key.
- End-to-end encryption for password accounts. The password is stretched in
  the browser and independently derives the credential sent to Better Auth
  and the non-extractable AES-GCM key used for records, settings, and images.
- Minimal infrastructure. Static assets do not invoke the Worker. D1 stores
  opaque records, R2 stores browser-encrypted blobs, and live sockets carry
  only integer revision hints.
- Monochrome interface. State is expressed through inversion rather than an
  accent color; restrained syntax highlighting is the functional exception.

## Architecture

```text
Browser
  ├─ OpenRouter API ───── chat/search/vision/images (user-owned key)
  ├─ IndexedDB ───────── local conversations, messages, vault CryptoKey
  └─ /v1/*
       └─ Cloudflare Worker
            ├─ Better Auth + D1 ─ identity, sessions, opaque sync records
            ├─ R2 ────────────── encrypted generated images/attachments
            └─ Durable Object ── hibernating per-account revision socket

Cloudflare Assets ─────── static Next.js `out/` (no Worker invocation)
```

### Trust boundary

For email/password accounts, conversation records, synchronized settings,
the OpenRouter key, generated images, and attachments are encrypted in the
browser. The Worker moves or stores opaque bytes and cannot decrypt them.
Account identity, date of birth, session/security metadata, record ids,
revisions, and blob sizes are not end-to-end encrypted. OpenRouter and the
selected model provider see prompts and attachments sent to a model.

## Main surfaces

- `app/page.tsx` — application shell and active conversation.
- `components/chat/` — streaming transcript, composer, image generation,
  citations, syntax highlighting, and message navigator.
- `components/sidebar/` — searchable/resizable/collapsible history rail.
- `components/settings/` — account, keys, appearance, unlock and auth flows.
- `lib/transport.ts` — direct browser-to-OpenRouter streaming transport.
- `lib/db.ts` / `lib/conversations.ts` — local-first Dexie store.
- `lib/sync.ts` / `lib/blob.ts` — encrypted D1 record and R2 blob sync.
- `lib/auth-client.ts` / `lib/session.ts` — browser password derivation,
  sessions, settings, realtime connection, and device locking.
- `worker/src/index.ts` — authenticated sync, blob, live, state and deletion
  routes.
- `worker/src/auth.ts` — Better Auth, age gate, persistent rate limiting, and
  optional email OTP.
- `worker/src/live.ts` — content-free Durable Object invalidation hub.
- `wrangler.jsonc` — Worker, static assets, D1, R2 and Durable Object bindings.

`CLAUDE.md` contains the detailed invariants and design law. Read it before
changing auth, encryption, streaming persistence, sync cursors, or scroll
behavior; those areas contain fixes for real data-loss and browser bugs.

## Local development

Requirements: Node 24+ and a recent Wrangler 4 release.

```bash
npm install
cd worker && npm install && cd ..
npm run dev
```

The static frontend can run on its own. Account/sync testing additionally
needs Wrangler with local D1/R2/DO bindings:

```bash
npx wrangler dev
```

OpenRouter keys are entered in the app. There is no frontend `.env` file and
no server-held model credential.

## Cloudflare setup

The checked-in config expects:

- D1 database: `chat-vault`
- R2 Standard bucket: `chat-blobs`
- SQLite-backed Durable Object class: `SyncHub`
- Worker secret: `AUTH_SECRET`

Create the bucket once, then apply both idempotent schemas:

```bash
npx wrangler r2 bucket create chat-blobs
npx wrangler d1 execute chat-vault --remote --file worker/schema-auth.sql
npx wrangler d1 execute chat-vault --remote --file worker/schema-app.sql
```

Build and deploy:

```bash
npm run build
npx wrangler deploy
```

### Optional public blob domain

Authenticated Worker downloads are the correctness fallback. To avoid a
Worker invocation for encrypted blob reads, connect an R2 custom domain such
as `blobs.belayet.co`, allow CORS GETs from `https://chat.belayet.co`, and set
`BLOB_PUBLIC_ORIGIN` to that origin in the Worker. Only encrypted accounts are
given direct URLs; unencrypted-account blobs stay behind authentication.

### Optional email verification

The signup UI and Better Auth OTP flow are implemented but remain disabled
until both `EMAIL` (Cloudflare Email Sending binding) and `EMAIL_FROM` exist.
Cloudflare’s general transactional Email Sending product currently requires a
Workers Paid plan; free Email Routing can send only to pre-verified destination
addresses and cannot verify arbitrary signups. Without the binding, signup
continues without email verification rather than locking users out.

Google remains a disabled UI placeholder until its redirect URI and secret
are intentionally configured.

## Verification

```bash
npm run lint
npm run build
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck \
  --target es2022 --module esnext --moduleResolution bundler \
  --types ./worker/node_modules/@cloudflare/workers-types \
  worker/src/index.ts worker/src/auth.ts worker/src/live.ts worker/src/env.d.ts
node worker/gen-schema.mjs
```

The generated auth schema must match `worker/schema-auth.sql` after every
Better Auth option or version change.

## Privacy and deletion

The static policy is at `/privacy`. Account deletion removes Better Auth
identity/session rows, D1 state and records through foreign-key cascades, and
all R2 objects under the account prefix. Verify that
`privacy@belayet.co` is a working mailbox before treating the policy as final.

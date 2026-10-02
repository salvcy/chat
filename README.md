# Chat

A minimal, cloud-first OpenRouter chat client with end-to-end encryption for
email/password accounts.

The frontend is a static Next.js export. Inference, model discovery, search,
vision, PDFs, and image generation run directly from the browser against
OpenRouter with the user’s own key. Cloudflare provides the account layer: a
Worker with Better Auth, D1 as the authoritative chat store, R2 for encrypted
images/attachments and oversized messages, and hibernating Durable Objects for
realtime updates — revision hints, plus sealed live frames that mirror a reply
to the account's other devices while it streams.

Live: [chat.belayet.app](https://chat.belayet.app)

## Product principles

- **One source of truth.** D1 owns threads and messages. The browser holds only
  the open transcript and sidebar in memory; there is no local conversation
  database to reconcile.
- **Bring your own key.** OpenRouter traffic goes directly from the browser to
  OpenRouter. The operator never receives or pays for model requests.
- **End-to-end encryption.** Email/password accounts derive an auth credential
  and a separate AES-GCM vault key from the same client-side PBKDF2 pass. D1 and
  R2 receive sealed content.
- **Deliberate device security.** The non-extractable vault key is remembered in
  IndexedDB by default so refreshes stay unlocked. A synced “lock on exit” mode
  keeps it in memory only and requires the password after a refresh.
- **Minimal infrastructure.** Static assets bypass the Worker. Streaming saves
  are checkpointed, serialized per thread, and realtime sockets carry a
  revision and random thread id — or, while a reply streams, frames sealed
  with the vault key that the hub relays without reading or storing.
- **Monochrome interface.** State is expressed through fill and inversion
  rather than accent colors; restrained syntax highlighting is the functional
  exception. Surface structure — hairlines, layered shadows, gliding
  highlights, loaders — is adapted from
  [Beautiful UI](https://www.beautifului.dev) (MIT).

## Architecture

```text
Browser
  ├─ OpenRouter API ─── chat/search/vision/PDFs/images (user-owned key)
  ├─ memory ─────────── open transcript + sidebar
  ├─ IndexedDB ──────── optional non-extractable vault key only
  ├─ localStorage ───── appearance + device-key preference only
  └─ /v1/*
       └─ Cloudflare Worker
            ├─ Better Auth + D1 ─ identity, settings, threads, messages
            ├─ R2 ────────────── encrypted images, files, large payloads
            └─ Durable Object ── hibernating per-account invalidation hub

Cloudflare Assets ───── static Next.js `out/` export
```

The server can see account identity, timestamps, random record ids, thread
shape/order, blob sizes, and storage totals. For password accounts it cannot
read titles, messages, settings, the OpenRouter key, generated images, or
attachments. OpenRouter and the selected model provider necessarily receive
the prompts and files sent to them.

## Main surfaces

- `app/page.tsx` — login/unlock gates, application shell, active conversation.
- `components/chat/` — streaming transcript, composer, tools, citations,
  syntax highlighting, and message navigator.
- `components/sidebar/` — searchable, resizable, collapsible thread history.
- `components/settings/` — auth, account, key, appearance, and device security.
- `lib/transport.ts` — direct browser-to-OpenRouter streaming transport.
- `lib/store.ts` / `lib/conversations.ts` — sealed cloud reads/writes and
  ordered streaming checkpoints.
- `lib/session.ts` / `lib/keystore.ts` — session, realtime revisions, settings,
  lock state, and optional browser key retention.
- `worker/src/index.ts` — authenticated state/thread/blob/account endpoints.
- `worker/src/live.ts` — content-free hibernating invalidation hub.
- `ARCHITECTURE.md` and `CLAUDE.md` — protocol invariants and design law.

## Local development

Requirements: Node 24+ and Wrangler 4.

```bash
npm install
cd worker && npm install && cd ..
npm run dev
```

The Next.js server can render the frontend alone. Account and storage testing
needs Wrangler’s local D1/R2/Durable Object bindings:

```bash
npm run build -- --webpack
npx wrangler dev
```

OpenRouter keys are entered in the app. No server-held model key or frontend
environment variable is required.

## Cloudflare setup

The checked-in configuration expects D1 database `chat-vault`, R2 bucket
`chat-blobs`, Durable Object class `SyncHub`, and Worker secret `AUTH_SECRET`.

```bash
npx wrangler r2 bucket create chat-blobs
npx wrangler d1 execute chat-vault --remote --file worker/schema-auth.sql
npx wrangler d1 execute chat-vault --remote --file worker/schema-app.sql
npm run build -- --webpack
npx wrangler deploy
```

Google remains a disabled placeholder. Email OTP activates only when both the
`EMAIL` binding and `EMAIL_FROM` exist; without them signup remains immediate.

## Verification

```bash
npm run lint
npm run build -- --webpack
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck \
  --target es2022 --module esnext --moduleResolution bundler \
  --types ./worker/node_modules/@cloudflare/workers-types \
  worker/src/index.ts worker/src/auth.ts worker/src/live.ts worker/src/env.d.ts
```

The privacy policy is at `/privacy`. Verify that `privacy@belayet.co` is a
working mailbox before treating it as final.

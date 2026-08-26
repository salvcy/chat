@AGENTS.md

# Chat — project law for future sessions

A minimal chat interface for every model, through one OpenRouter key.
Single user, no auth. Local-first. This file locks the stack and the
design system — don't deviate without the user explicitly approving it.

## Stack (locked)

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript ^5**
  (stay on 5 — don't chase TS 7/native).
- **Tailwind CSS v4** — CSS-first config. Design tokens live in
  `app/globals.css` as custom properties on `:root` (light) and `.dark`,
  wired through `@theme inline`. `dark` variant via `@custom-variant dark`.
  Default theme is **dark**, applied by a pre-paint boot script in
  `app/layout.tsx` reading `localStorage("dial:theme")` (no flash, no
  cross-fade on toggle — see ThemeToggle).
- **AI SDK v7** (`ai`) + **`@ai-sdk/react` v4** (`useChat` +
  `DefaultChatTransport` from `ai`) +
  **`@openrouter/ai-sdk-provider` v3** (`createOpenRouter`).
- **Motion**: `motion` v13 (import from `motion/react`; `framer-motion`
  is the legacy alias — don't add it).
- **Geist Sans (400/500/600) + Geist Mono** via `next/font/google`.
- Package manager: **pnpm**. Deploy target: Vercel.
- **Versions move fast.** Re-verify current majors at the start of each
  phase; if a version has drifted, flag it to the user — never silently
  substitute something else.

## Environment / machine notes

- On the Windows box use `pnpm.cmd` / `npm.cmd` (PowerShell's execution
  policy blocks the `.ps1` shims). On the macOS box `pnpm` is **not
  installed** and `node_modules` is npm-managed — don't add dependencies
  there, or you'll end up with a `package-lock.json` fighting
  `pnpm-lock.yaml`.
- **There are no environment variables.** Not "none required" — none at all;
  `grep process.env` returns nothing. The OpenRouter key belongs to the user
  and lives in their browser, and the former `OPENROUTER_*` settings are now
  constants in `lib/types.ts`. A leftover `.env.local` is inert.
- There is no server to curl. To exercise the stream, drive the browser —
  the request goes from the tab to `openrouter.ai` and nowhere else.

## Architecture

The organizing idea after the v2 rework: **the app measures what it does.**
Every assistant message carries a flight recorder, and the model catalog
carries a capability surface — so the mono readouts have real numbers and
the controls can't offer something the model won't honour.

The organizing idea after the v3 rework: **nothing we pay for sits in the
token path.** The user brings their own OpenRouter key and the browser talks
to OpenRouter directly, so inference costs the operator exactly nothing at
any volume, a long reasoning answer cannot hit a function timeout, and a
generated image travels once instead of twice.

### Auth (`worker/src/auth.ts`)

Better Auth — email+password, Google, sessions — on D1. Three things are
unusual and all three follow from **the Workers free tier allowing 10ms CPU
per request**:

- **The server never receives a password.** The browser runs PBKDF2-SHA256
  at 600k iterations (OWASP's figure when Argon2id is unavailable — and it is
  unavailable, because the frontend cannot take a WASM dependency) and sends
  the derived value. `hashPassword` is therefore a salted SHA-256, which is
  correct rather than lazy: the input is 256 bits of high-entropy output and
  there is nothing left to guess. `looksPreStretched` rejects anything that
  is not exactly 43 base64url characters, so a client that skipped the
  derivation cannot get a raw password stored under a fast hash.
- **The same PBKDF2 pass yields the vault key.** `HKDF("auth")` goes to the
  server; `HKDF("vault")` never leaves. That is why email/password accounts
  get E2EE with no extra passphrase — and why Google accounts cannot: OAuth
  proves identity and supplies no key material, so E2EE there needs a
  separate passphrase the user types per device.
- **Never hand-write the auth schema.** `node gen-schema.mjs > schema-auth.sql`
  derives it from the same `createAuth` the Worker runs. The deprecated
  standalone `@better-auth/cli` resolved to 1.4.21 against a 1.7.1 runtime,
  omitted `account.issuer`, and every signup 500'd with a SQLITE_ERROR buried
  in the logs. Regenerate after any auth-option change or version bump.

Measured CPU on the free tier (`wrangler tail`): sync 3–8ms, sign-in ~11ms,
**signup 30ms median / 55ms peak**. Nothing was throttled across 34 requests,
but signup is several times the documented limit — watch for 1027s. Caching
the auth instance per isolate did *not* fix it; the cost is Better Auth's own
signup work plus two D1 writes, not construction.

### The Worker (`worker/`, deployed from `wrangler.jsonc`)

The only server, and it cannot read anything it stores. `worker/src/index.ts`
is four endpoints — mint an account from a token verifier, pull records above
a cursor, push records, delete everything — over D1. Deployed as one Worker
on **chat.belayet.co** that also serves the static export, so the app and its
API share an origin: no CORS preflight, no cross-site cookie configuration.

- **Zero dependencies, deliberately.** Workers bill CPU and the free tier
  allows 10ms; a router and an auth library would spend it on nothing. A
  request costs one SHA-256 and one indexed lookup. `worker/src/env.d.ts`
  hand-declares the four D1 methods used rather than pulling in
  `@cloudflare/workers-types`. The Worker is ~7KB.
- **Better Auth is in, and `nodejs_compat` is required** (it reaches for
  `node:crypto` and `AsyncLocalStorage`; without the flag the deploy fails
  validation). It was correctly *out* while identity was a bare token — no
  password, no email, no session cookie — and correctly back in once
  email/password and Google arrived. The bundle went from 7KB to 313KB
  gzipped; that is the price and it is worth it for flows nobody should
  hand-roll.
- **The Google provider is registered only when its secret is set.** Passing
  an undefined `clientSecret` makes Better Auth throw at construction, which
  takes email/password down with it — the entire API 500s because one
  optional provider was half-configured.
- **Absence of a key is not evidence that an account is unencrypted.** This
  caused real data loss: a device whose IndexedDB had been cleared still had
  a valid session cookie, took the "no key" branch, and overwrote the
  account's encrypted settings with plaintext defaults — after which the
  correct password could no longer open it, because the blob it was asked to
  decrypt was no longer ciphertext. `pushRemote` now refuses
  (`WouldDowngradeError`) and `adopt` bails to `locked` first. The server's
  `encryption` field is the authority, never the local key.
- **Never sync an encrypted account without its key.** `runSync` throws
  `LockedError`. The earlier version pulled ciphertext, failed to read every
  record, and *still advanced the cursor past all of it* — leaving a
  signed-in user with an empty history sitting above a revision the device
  would never ask for again. `unlock` also calls `clearCursor()`, because
  regaining a key means you do not know what you missed.
- **The session cookie is httpOnly and outlives local storage.** Clearing
  site data leaves someone authenticated and keyless. That is the `locked`
  state, and it needs its own UI — an empty transcript reads as lost data.
- **A cookie-cached session outlives the account it belongs to.** Sessions
  are read from a signed cookie for five minutes to save CPU, so a deleted
  user's cookie stays cryptographically valid. `loadState` returns null when
  the user row is gone and the router turns that into a 401 — without it the
  request hit a foreign-key violation and 500'd, which is a deleted account
  failing *open*.
- **`payload` is opaque. Never parse, index, or log it.** Wanting to know
  something about a record's contents means the client should send that fact
  explicitly, as a decision to leak it; it is never a reason to look inside.
- `worker/schema.sql` documents exactly what a full database dump reveals:
  account count, record count, record sizes. There is deliberately no `kind`
  column, no parent id, no sequence number, no title.

### The account (client)

- `lib/auth-client.ts` — PBKDF2(600k) → HKDF split. Better Auth ships a
  client SDK but it lives in `worker/node_modules` and the frontend takes no
  new dependencies, so the endpoints are called with plain `fetch`. **Keep
  `APP_SALT` and the iteration count identical to the Worker's expectations**
  — a change here locks every existing account out.
- `lib/session.ts` — `useAccount()`. Session, settings, sync and the locked
  state, in that order of dependency.
- `lib/settings.ts` — one opaque blob (theme, typeface, text size, column
  width, density, OpenRouter key), encrypted whenever the account has a key.
  The key is billable, so this blob is never stored in the clear.
- `components/settings/` — `AuthPanel` (sign in / create / Google),
  `SettingsPanel` (account · keys · appearance), `UnlockBar`.
- `components/sidebar/AccountButton.tsx` — the rail footer. `shrink-0`
  sibling of the scrolling list, same reason as the header.

**Appearance never goes through React state.** Theme, typeface, text scale,
column width and density are CSS custom properties on `:root`, set by the
boot script pre-paint and by `applyAppearance` afterwards — the same pattern
as `--dial-rail-w`, and for the same two reasons: a preference change must
not re-render the transcript, and a stored value must be readable before
first paint without a hydration mismatch. `.dial-column` and `.dial-rows`
are the only places those values are consumed.

### The vault (client)

- `lib/crypto.ts` — one token, three derivations. `HKDF("auth")` → the
  bearer the server hashes; `HKDF("vault")` → the AES-GCM key that never
  leaves. **HKDF, not Argon2/PBKDF2**: the token is 240 bits of
  `getRandomValues`, so there is nothing to guess and stretching would burn
  a second of the user's CPU for zero security. That same fact is what keeps
  the Worker inside its CPU budget.
- `lib/sync.ts` — pull, then push. That order is what makes a local edit
  win on the device being typed on. Last-writer-wins per record is correct
  here, not lazy: messages are append-only and there is no concurrent editor.
- `lib/vault.ts` — session lifecycle. The session lives in Dexie holding a
  **non-extractable `CryptoKey`**; the token itself is never persisted. So
  injected script can use the vault but cannot carry it away.
- `components/settings/VaultPanel.tsx` — the token is shown once and the
  confirm button stays disabled until the checkbox is ticked. That friction
  is deliberate and is the only place in this app that should have any.

### No app backend

There is no `app/api`. The five route handlers that used to live there —
`chat`, `models`, `title`, `key`, `image` — became client modules, because
OpenRouter serves `Access-Control-Allow-Origin: *` and allow-lists the
`Authorization`, `HTTP-Referer` and `X-Title` headers on every endpoint this
app touches. `next.config.ts` is therefore `output: "export"`: the whole
build is static files, which Cloudflare serves free and unmetered without
invoking a Worker.

- `lib/credentials.ts` — the user's OpenRouter key, behind a
  `CredentialStore` interface. Device-local today (`localStorage`, never
  Dexie — Dexie is what step 2 syncs). The interface exists because the
  backing store is going to move into the encrypted vault; the doc comment
  names the three planned identity modes so the seam stays shaped for all
  of them.
- `lib/pkce.ts` — OpenRouter OAuth PKCE. The user authorizes on
  openrouter.ai and returns with a key scoped to this app, revocable on its
  own. PKCE is what makes this safe with no server: there is no client
  secret to hide, because possession of the one-time verifier is the proof.
- `lib/openrouter-client.ts` — the browser provider factory, cached per key.
- `lib/transport.ts` — a `ChatTransport` running `streamText` in the tab.
  This is `app/api/chat/route.ts`, same work in the same order, minus the
  parts that only protected a server: request re-validation, payload caps,
  and hiding the system prompt from its own author. The flight recorder
  ports over exactly, `usage: { include: true }` included, so every mono
  readout is still a measured number.
- **PDFs go through OpenRouter, not through us.** A document is an ordinary
  `file` part; the provider encodes it as `{type:"file",file:{filename,
  file_data}}` and OpenRouter reads it. `pdfEngineFor` picks `native` when the
  catalog advertises `file` input (the model sees real pages, billed as
  ordinary input tokens) and the free `cloudflare-ai` otherwise. The engine is
  **always** stated: OpenRouter's own default is `mistral-ocr` at $2 per 1,000
  pages, and nobody should be billed for OCR they did not ask for.
  `mistral-ocr` is therefore never selected automatically. Attachments are
  never gated on `vision` any more — an image needs an image model, a PDF does
  not — and PDFs ride the existing R2 attachment path for free.
- `lib/catalog.ts` — the same normalization as before, now client-side.
  `/models` needs no key, which is what lets the model list populate behind
  the connect screen. Cached an hour in `localStorage` (~220KB, written on
  refetch rather than per load).
- `lib/title.ts` / `lib/image.ts` / `lib/account.ts` — the other three
  routes. All best-effort, all direct.

### Client

- `lib/types.ts` — client-safe. `ReasoningEffort` is OpenRouter's **full**
  scale (`off|minimal|low|medium|high|xhigh`), `DialMetadata` is the flight
  recorder, `ChatSettings` is the per-thread knob set.
- `lib/capabilities.ts` — resolves catalog capabilities into offerable
  controls. `reconcileSettings()` coerces a thread's knobs to what the
  selected model can serve; it is applied **derived on read** in `page.tsx`,
  never written back from an effect.
- `lib/format.ts` — the readout formatters. `formatCost` deliberately keeps
  4dp under a cent: rounding a $0.00004 turn to "$0.00" would lie.
- `lib/syntax.ts` — restrained, theme-aware Prism palette. Code is the one
  functional exception to the monochrome chrome: low-chroma semantic colors
  distinguish keywords, strings, numbers, functions and types.
- `lib/db.ts` — Dexie **v2**: `conversations` (+ `system`, `pinned`,
  `totalCostUsd`, `totalTokens`, `titleGenerated`) and `messages`
  (+ `seq`, with a `[conversationId+seq]` compound index — IndexedDB
  guarantees no insertion order, so thread order is stored explicitly).
  v1→v2 upgrade backfills both.
- `lib/conversations.ts` — `useConversations()`. `saveTurn` **reconciles
  rather than appends**: messages absent from the passed array are deleted,
  which is what makes edit/regenerate/branch safe (otherwise orphan
  branches reappear on reload). Titles are generated once per thread; a
  hand-typed rename sets `titleGenerated` and is never overwritten.
- `lib/export.ts` — Markdown + JSON conversation export.
- `lib/sources.ts` — dedupe/label helpers for web-search sources. Tracking
  parameters, fragments, and trailing slashes are canonicalized so variants
  of the same page cannot become duplicate numbered citations.
- `components/settings/KeyGate.tsx` — the front door. OAuth first, paste
  second; the paste path exists because being locked out of your own history
  by an OAuth hiccup is not acceptable. A pasted key is verified against
  `/key` before it is stored, so a typo fails there with a reason instead of
  three screens later as a mystery stream error.
- `lib/preferences.ts` — things that outlive a conversation: **session
  defaults** (model + reasoning + search, so a new chat inherits the knobs you
  were last using — only the model used to carry over) and **rail geometry**
  (width + collapsed).
- `app/page.tsx` — the shell. Owns catalog, active thread, settings.
  `view` (empty state) and `effective` (reconciled settings) are **derived
  during render**, not stored — writing them from effects cascades renders
  and trips `react-hooks/set-state-in-effect`.
- `components/chat/ChatView.tsx` — keyed per conversation. Stop (button +
  Esc), regenerate, edit-and-resend (truncate + resend), branch,
  jump-to-bottom, retry with a class-specific hint, and a **mid-stream
  snapshot every 1.2s** so closing the tab on a long answer no longer
  throws it away.
- `components/chat/Composer.tsx` — capability-driven. The reasoning menu
  offers exactly the model's advertised efforts; search greys out *with a
  reason* on models that cannot call the web-search tool. Send inverts to a
  stop square while busy.
- `components/chat/Metrics.tsx` — the per-message flight recorder. Collapsed
  = tok/s · duration · cost; expanded = provider, ttft, token split.
- `components/chat/ThinkingPanel.tsx` — **one** pre-answer telemetry row, not
  two. Reasoning and web search share a header ("thought for 11.4s · 3
  sources"). Expanding reveals the trace plus a compact, singly numbered
  source list (`1 · example.com`); Citations still provides the answer's
  canonical `[1] [2]` links below the response. `thinkingMs` is measured server-side at the first-reasoning →
  first-text boundary, so a slow provider queue isn't counted as thinking.
  Auto-collapses when the answer starts unless the reader opened it.
- `components/chat/MessageActions.tsx` — copy / edit / regenerate / branch,
  revealed on hover.
- `components/chat/MessageNavigator.tsx` — a container-aware transcript
  minimap beside the scrollbar. Compact markers use a springy proximity
  response (hovered, then neighboring bars), with no persistent single-marker
  highlight; hover/focus previews text, and click smooth-scrolls.
- `components/chat/SystemPrompt.tsx` — per-conversation prompt + presets.
- `components/tuner/Palette.tsx` — **the one floating surface.** ⌘K opens it
  straight into model mode (the signature interaction must not cost an extra
  keystroke); typing `>` switches the same surface to commands. Arrow-key
  nav, recents, capability chips, a concrete `web` filter for models that can
  call the app's search tool, and the tuner-tick on select.
- `components/tuner/StatusStrip.tsx` — the readout the README always drew
  and never got built: model · thread cost · thread tokens · key balance.
- `components/sidebar/ConversationList.tsx` — filter, date grouping, pin,
  export, rename, delete; per-row cost. Two tight lines per row; one quiet
  ellipsis opens a compact action menu instead of four icons covering the
  active-row treatment. The ellipsis overlays the title on hover rather than
  reserving a right column, keeping the model and cost aligned to the rail.
  A compact search button expands an inline title/model filter in the rail
  header; Escape closes and clears it.
- `components/sidebar/RailHandle.tsx` / `RailToggle.tsx` — drag-to-resize
  (180–460px, double-click resets) and collapse (⌘B).
- `components/chat/Citations.tsx` — one row of numbered links (`[1] [2] [3]`) linking
  out, title+domain on hover. It was a full-width footnote block, which for a
  five-source answer was taller than the answer.
- `components/ui/Dropdown.tsx` — carries a `disabledReason`. Open state is
  derived (`open && !disabled`) so a model switch can't strand it.

### Rules learned the hard way

- **A revision must be allocated by the database, not derived from a read.**
  `push` computed `state.rev + 1` from a row read earlier in the request, so
  two devices pushing at once both wrote the same revision — and a third
  device that pulled between the two writes advanced its cursor past it and
  never asked for the second batch again. `UPDATE … RETURNING rev` is the fix.
  Realtime is what turned this from theoretical into routine, because it made
  two devices online at the same time the normal case.
- **`PAGE_SIZE` must stay strictly greater than `MAX_PUSH_RECORDS`.** The pull
  cursor advances to the last row's revision, so every record sharing a
  revision has to fit in one page or the remainder is skipped permanently.
- **Never echo a revision to the device that caused it.** The hub fans out to
  every socket; before the connection-id tag, a device pushing mid-stream woke
  itself, found the rows its own 1.2s snapshot had just re-dirtied, pushed
  again, and looped at round-trip speed.
- **A pull is invisible until something re-reads it.** `applyRecords` writes
  straight into Dexie, which is not React. The rail refreshed (it reloads when
  sync settles) and the open transcript did not — which is the whole reason
  cross-device sync looked broken while it was working perfectly. ChatView now
  adopts remote changes, but never while busy, never twice for the same
  version, and never when the stored copy is missing a message it is holding
  (that means our own save is still in flight). The cost of the last guard is
  that a *truncation* made elsewhere waits for a thread switch; losing a
  locally streamed answer would be worse.
- **`saveTurn` must only rewrite what changed.** It marked the entire thread
  dirty on every save, so one turn in a fifty-message conversation queued
  fifty records — and the mid-stream snapshot did it again every 1.2s, about
  two thousand row writes for a single long answer. Comparing a cheap content
  key first also preserves the R2 blob references the sync engine writes into
  those rows, which is what stopped images being re-uploaded forever. The key
  hashes text in full (a same-length edit must not hide) but reads only the
  *size* of attachments — hashing megabytes of base64 every 1.2s would cost
  more than the writes it saves, and reaching into those parts would pick up
  the very blob ids that must not count as a change.
- **Local durability and cloud freshness are different clocks.** The snapshot
  stays at 1.2s because that is what stops a closed tab losing a long answer.
  Pushing it to D1 at the same rate is a separate question, and the answer is
  no: `DRAFT_SYNC_MS` throttles streaming pushes to ~5s, which still reads as
  live on another device for a tenth of the writes.
- **The 128KB record cap is really ~90KB of text.** `sealRecord` base64s the
  ciphertext, a 4/3 expansion on top of JSON escaping, so a long reasoning
  answer overflowed it — and because one rejected batch throws, a single
  message stopped the whole account's sync. Payloads over 96KB now spill to
  R2 behind an `@r2:` sentinel. The spilled bytes are the *sealed* payload, so
  nothing is encrypted twice and the service learns nothing new; the object id
  shares the record's prefix, so deleting the record erases it.
- **`body { overflow: hidden }` is for the chat shell and breaks every other
  page.** The privacy policy is an ordinary document taller than the viewport,
  so it has to be its own scroll container or it cannot be read past the fold.

- **The shell mints the conversation id, including for unsaved threads.** If
  ChatView minted its own and `onFinish` flipped `activeId` before the save
  landed, the chat's key changed mid-write, ChatView remounted, and the shell
  re-read an empty thread out of Dexie — the first exchange vanished a beat
  after it arrived. Save first, announce second, and never let the key change.
- **Never put `container-type` on an ancestor of a scroll container.** This
  was the cause of the Safari-only scroll bug, and it took two wrong
  diagnoses to find. `container-type: inline-size` silently applies
  `contain: layout style inline-size`; with that on `.chat-scroll-region`,
  the direct parent of the scroller, WebKit restored the scroll position on
  every re-layout — so scrolling up jumped to the top and the jump-to-bottom
  control snapped straight back. Chrome implements containment correctly and
  never showed it; iPhone Safari never matched the query, so the minimap
  never rendered and nothing churned. Measure with a ResizeObserver and write
  an attribute instead (`data-roomy`). The one-line confirmation was
  `document.querySelector('.chat-scroll-region').style.containerType='normal'`.
- **`el.scrollTop = el.scrollHeight` is not "scroll to the bottom".** It only
  behaves like it because browsers clamp the value to
  `scrollHeight - clientHeight`; when that maximum is momentarily zero the
  write lands at zero — the top. Fixed alongside the above, but note it was
  *not* the cause of the Safari symptom: it is a latent bug that was
  corrected on the way past. Diagnosing a rendering bug by mechanism-that-
  could-explain-it rather than by bisecting the actual page is how two
  deploys went out without fixing anything.
- **Safari reports a fractional `scrollTop`; `clientHeight` is an integer.**
  A trackpad delivers sub-pixel deltas, so "moved less than 1px" is true for
  a real, deliberate slow scroll — it is not a safe test for "this scroll
  event came from a layout change". Credit a scroll to the reader only if a
  `wheel`/`touchmove`/`keydown` landed within `GESTURE_WINDOW_MS`.
- **Scrolling up is an instruction, not a measurement.** Deciding purely on
  distance meant a small scroll up stayed inside the threshold and the next
  token dragged the reader back down. Release the follow on any reader-driven
  upward scroll, and re-engage only within a tighter threshold — the
  hysteresis is what stops Safari's rubber-band bounce, which settles
  *downward*, from re-engaging the follow the reader just cancelled.
- **rAF is frozen in a hidden/background pane, and so is Motion.** The
  ResizeObserver follow path goes through `requestAnimationFrame`, so it
  cannot be exercised from an automated browser whose pane is hidden. A
  `requestAnimationFrame` probe that never resolves is the tell; do not read
  that as a regression in the scroll code.
- **A rounded container must not also be the scroll container.** The rail's
  `<aside>` owns the 18px radius and border; making it `overflow-y-auto` ran
  the scrollbar track the full height and into the top corners, reading as a
  bar bleeding past the header. The header is a `shrink-0` sibling and only
  the list below it scrolls (`.dial-scroll-none` — scrollable, no visible bar,
  because a 6px track in a 240px rail is noise).
- **Don't put `overflow-*` on a row that hosts a dropdown.** A scroll
  container clips in *both* axes, so a menu anchored `bottom-full` is
  silently swallowed — it looks exactly like a dead click.
- **A turn can end with nothing to show and no tag on it.** `onFinish`
  attaches the `data-requestStatus` part, but it never runs when the tab is
  closed or reloaded mid-answer. `lib/messages.ts` holds the shared predicates
  (`hasRenderableResponse` / `streamNeverFinished` / `inferRequestStatus`) so
  ChatView can tag a finished turn and MessageBubble can recognise an untagged
  one at render time — keep those two in agreement or a turn will either lose
  its placeholder or grow a second one. `durationMs` is the tell: only the
  `finish` handler writes it, so `startedAt` without it means the stream was
  cut off. A *failed image* looks the same, which is why the truncation notice
  is scoped away from image turns.
- **An effect that reads `messages` is torn down on every token.** The
  mid-stream snapshot timer must depend only on `busy` and read the latest
  messages from a ref, or its cleanup cancels the pending save forever.
- **Padding belongs on the wrapper, not on the element holding the text.** A
  selection highlights whole line boxes, so a padded `<p>` highlights 16px of
  empty space before the first character and after the last — a message
  selected by double-click looked like a band of grey around the words.
- **No focus ring on text fields.** The caret is the affordance; a box around
  the borderless composer textarea reads as a stray outline.
- **The rail shares the transcript's ground.** Glass is for things that
  float; `bg-surface` on a pinned sidebar reads as a different application.
- **Validate model ids against the *catalog*, not against intuition.**
  `MODEL_ID_PATTERN` has to accept everything `/api/models` will offer, or the
  switcher lists models the route then 400s on. OpenRouter publishes floating
  aliases prefixed with `~` (`~anthropic/claude-sonnet-latest`) — twelve of
  them. If the pattern changes, re-run it over the live catalog.
- **OpenRouter's 401 does not say 401.** A dead or revoked key comes back as
  `"User not found."` in the response body. Matching only on `/401|unauthor/`
  fell through to the generic hint and told people to switch models, which
  sends them to debug the wrong thing. `describeStreamError` in the transport
  prefers the upstream body over the SDK's generic message for the same
  reason — "insufficient credits" is actionable, "Failed after 3 attempts"
  is not.
- **Never put the user's key in a field yourself, and never in Dexie.**
  It is device-local in `localStorage` precisely because Dexie is what gets
  synced in step 2; a key in a synced table is a key in someone's cloud.
- **`DirectChatTransport` looks like the answer and isn't.** AI SDK v7 ships
  one, but its generic is `UIMessage<unknown, never, …>` — the `never` is the
  data-parts slot, and this app has two (`data-image`, `data-requestStatus`).
  It also wants a fixed `Agent`, while model/effort/search change per turn.
  The hand-rolled transport is ~60 lines over `toUIMessageStream`.
- **The transport takes the settings *ref*, not a closure over it.** It is
  built once per conversation with `useMemo(…, [])`, so a captured value
  would send the previous model on the turn right after a switch — and
  `() => ref.current` created during render trips `react-hooks/refs`. Passing
  the ref object itself solves both.
- **Errors from this app must not be labelled "upstream".** The route returns
  `{"error":"…"}`; the provider sends a bare string. ErrorPanel distinguishes
  them, because printing a local 400 as raw JSON under "UPSTREAM ERROR" sends
  people to debug OpenRouter for our bug.
- **Rail geometry goes through a CSS custom property, not React state.**
  `--dial-rail-w` is set by the boot script pre-paint and written directly by
  the drag handle — width in state would re-render the whole list on every
  pointer move, and would hydration-mismatch against the server render.
- **Anything read from `localStorage` during render must be gated on
  `conv.ready` before it's displayed**, or the server render (which can't see
  storage) and the client's first render disagree. StatusStrip takes a `ready`
  prop for exactly this reason.
- **Never `setState` synchronously in an effect body**, and never write a
  ref during render — the React 19 lint is on and both are errors. Derive
  instead, or reset in the event handler that caused the change.
- **Don't add dependencies.** `pnpm` is the locked package manager but
  isn't installed on the macOS box; `node_modules` there is npm-managed.
  Installing via npm would leave two divergent lockfiles.

- Roadmap phases: 0 scaffold ✓ · 1 core loop ✓ · 2 model switcher ✓ ·
  3 reasoning + web search ✓ · 4 persistence + sidebar ✓ · 5 design pass ✓ ·
  **6 instrument rework ✓** (telemetry bus, capability-aware controls,
  system prompt, edit/regenerate/branch, unified palette, export,
  semantic syntax highlighting, generated titles, streaming persistence) ·
  **7 client transport ✓** (inference moved into the browser, BYO key via
  OAuth PKCE, all five API routes deleted, static export, CSP in
  `public/_headers`) ·
  **9 accounts ✓** (Better Auth on D1, email+password with client-side
  stretching, Google provider wired, 18+ gate enforced in a database hook,
  settings blob + encryption mode per user, account deletion) ·
  **8 vault ✓** (token identity, HKDF+AES-GCM client-side encryption, D1
  record store, pull/push sync over Dexie, account deletion, deployed to
  chat.belayet.co) ·
  **10 client accounts ✓** (sign-up/sign-in/Google UI, 18+ gate, session
  restore, locked/unlock flow, session-authenticated sync, settings panel in
  the rail footer with theme/typeface/size/width/density and the OpenRouter
  key) ·
  **11 cloud hardening ✓** (image/attachment bytes encrypted in the browser
  and synchronized through R2; hibernating per-account Durable Object sockets
  fan out revision-only realtime invalidations; Better Auth rate limits use
  global D1 counters; account deletion clears R2; static privacy policy;
  email-OTP UI and plugin activate conditionally when an outbound mail binding
  exists). Authenticated Worker blob reads are the fallback; the remaining
  deployment optimisation is an R2 custom domain + CORS +
  `BLOB_PUBLIC_ORIGIN`, which removes Worker invocations for ciphertext reads.
  Google intentionally remains a disabled placeholder. ·
  **12 sync economics + documents ✓** (write amplification removed, oversized
  payloads spill to R2, PDF input via OpenRouter's file-parser). Next product
  work: sub-agent delegation and per-thread temperature (the wire already
  carries it).
## Design system (the law)

**Strictly black, white, neutral gray interface chrome — both themes, no
accent color.** State is shown by **inversion** (filled contrast-swapped
element), not color. Syntax highlighting is the sole functional exception.
No default shadcn look, no purple gradients, no generic dark+neon SaaS
aesthetic.

- Dark: bg `#0A0A0A` · surface `rgba(255,255,255,0.06)` + blur 20px ·
  fg `#F5F5F5` · muted `#8A8A8A` · hairline `rgba(255,255,255,0.10)` (1px
  max) · invert = `#FFF` fill / `#0A0A0A` text.
- Light: bg `#FAFAFA` · surface `rgba(0,0,0,0.04)` + blur 20px ·
  fg `#0A0A0A` · muted `#8A8A8A` (same both themes) · hairline
  `rgba(0,0,0,0.10)` · invert = `#0A0A0A` fill / `#FAFAFA` text.
- **Type split:** Geist Mono for anything the system *measured* (model
  slug, tok/s, latency, timestamps, reasoning trace); Geist Sans for
  anything a person *authored* (messages, labels). Numbers/process = mono,
  content = sans.
- **Layout:** centered 680px column (narrower than the 760–800px default).
  Assistant messages get **no bubble** — bare text on the page. User
  messages are the only bubbles: right-aligned glass pill, 14px radius.
  This asymmetry is deliberate.
- **Signature control:** the sticky top "tuner strip" — model switcher
  styled as a channel/frequency readout, not a dropdown. Its select
  animation (damped ~200ms ease-out with slight overshoot, a filled block
  inverting into place) is the one place motion may be expressive.
- **Code gets restrained semantic color.** `lib/syntax.ts` uses low-chroma,
  theme-aware token colors while the surrounding interface remains neutral.
  Every fenced block can collapse independently from its language header.
  Focus rings and `::selection` are hairline/inversion, not the browser's blue.
- **Motion elsewhere is quiet:** messages fade + 4px slide-up 150ms;
  streaming = opacity ramp per chunk (no blinking caret, no typewriter);
  always respect `prefers-reduced-motion`.
- **Theme toggle** swaps instantly — no cross-fade.

## Hard constraints / non-goals

- **Repealed (was a v1 non-goal):** no auth, no server storage, no sync.
  All three now exist. Dexie remains the source of truth and cloud sync is a
  replica of it — never the other way round.
- **Cloud sync is optional and must stay optional.** The app is fully usable
  with no account; the vault adds durability and a second device. Anything
  that turns it into a login wall is a regression.
- **Never widen `run_worker_first` beyond `/v1/*`.** Static asset requests
  are free and do not invoke the Worker. Widening that glob puts every page
  load onto the billable path.
- **The operator never holds a model key.** Users bring their own. Any
  change that reintroduces a server-held `OPENROUTER_API_KEY` is a
  regression — it puts the operator back in the billing path and makes the
  privacy claim on the connect screen false.
- **E2EE means our server cannot read it, not that nobody can.** OpenRouter
  and the upstream provider see every prompt in the clear. Say it that way.
- No billing/usage limits. No open-ended agentic tools beyond web search
  and (exploratory) model delegation — no file access, code execution, or
  general browsing. No voice.
- Reasoning comes back as a distinct `reasoning` part — use the part type,
  don't hand-parse it out of the answer.
- Web search uses the `openrouter:web_search` server tool (the model
  decides when to search) — **not** the deprecated `:online` slug suffix.

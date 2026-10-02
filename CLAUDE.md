@AGENTS.md

# Chat — project law for future sessions

A minimal chat interface for every model, through one OpenRouter key.
Accounts required, end-to-end encrypted, cloud-first. This file locks the
stack and the design system — don't deviate without the user explicitly
approving it.

## Stack (locked)

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript ^5**
  (stay on 5 — don't chase TS 7/native).
- **Tailwind CSS v4** — CSS-first config. Design tokens live in
  `app/globals.css` as custom properties on `:root` (light) and `.dark`,
  wired through `@theme inline`. `dark` variant via `@custom-variant dark`.
  Default theme is **dark**, applied by a pre-paint boot script in
  `app/layout.tsx` reading `localStorage("dial:appearance")` (no flash, no
  cross-fade on toggle — see ThemeToggle). That one key is the only thing in
  the app that reads local storage; the authoritative copy of every
  preference is the sealed settings blob on the account.
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

The organizing idea after the v4 rework: **there is one copy of the data.**
D1 holds it, the browser renders it, and the two are never asked to agree.
Every data-loss bug in this project's history had the same shape — two
stores, a cursor, and a merge rule that had to be exactly right — and none of
them can recur, because the second store is gone. What is left is a cache
with no durability obligations: losing it costs a refetch.

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

The only server, and it holds the only copy. `worker/src/index.ts` is five
data endpoints over D1 — list threads, read one thread, write a turn, delete a
thread, and ask what changed — plus state, blobs, live and account deletion.
Deployed as one Worker on **chat.belayet.app** that also serves the static
export, so the app and its API share an origin: no CORS preflight, no
cross-site cookie configuration. It lived on chat.belayet.co until October
2026; that custom domain was detached (its DNS record and certificate went
with it) and nothing redirects from it. Two strings still say
`chat.belayet.co` — the salts in `lib/crypto.ts` and `lib/auth-client.ts` —
and they are labels, not addresses: every existing credential and vault key
was derived with them, so they never change with the domain.

- **`thread` and `message` are typed, and the structure is in the clear.**
  `thread_id`, `seq`, `pinned`, `updated_at` and `deleted` are plain columns
  because sorting and grouping cannot be done through a seal; `meta` and
  `payload` stay AES-GCM sealed. A database dump reveals the *shape* of
  someone's usage — thread count, message counts, order, timing — and none of
  its content. That is a real disclosure, it is stated in those words in
  `schema-app.sql` and in the privacy policy, and it is what buys a page load
  costing one indexed query instead of downloading and decrypting the account.
- **`PUT /v1/threads/:id` is one endpoint because a turn is one atomic thing.**
  It can create the thread, truncate a tail, and write messages in a single
  `batch()`. Statement order inside that batch is load-bearing: thread upsert
  first (a new thread and its first message land together), then the truncate,
  then the inserts — an edit-and-resend truncates from seq 3 and immediately
  writes a new message at seq 3, and the other order deletes what it just
  wrote.
- **Message inserts are guarded by `WHERE EXISTS` on a live thread.** One
  device deleting a thread while another is streaming into it is a real race,
  and without the guard those rows land pointing at nothing — invisible to
  every read, because reads go through the thread, and therefore never cleaned
  up.
- **A checkpoint does not touch the thread row.** `touch` is what a streaming
  save leaves out. Bumping the thread alongside every checkpoint would double
  the rows written for a long answer to announce something no reader needs —
  the delta probe already sees the message move.
- **Tombstones are gone.** A deletion is a `DELETE` on the authoritative
  store. `thread.deleted` survives only long enough for a connected device to
  notice (`PURGE_AFTER_MS`), swept lazily inside the next delete's batch; a
  device that misses the window needs nothing, because its next list simply
  will not contain the thread.
- **Blobs are keyed by thread, not by message.** `<threadId>/<messageId>.…`
  makes deleting a conversation one R2 prefix delete. The old scheme fanned
  out one unbounded list/delete loop *per message* from a single request.
- **State is loaded per route, not up front.** Every request used to pay
  `getSession` + `loadState` before the router looked at the path, so a 404
  and a WebSocket upgrade cost the same D1 read as a write. Fetching an image
  is now one R2 get and no D1 at all.

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
- **Never read or write an encrypted account without its key.**
  `assertUnlocked()` in `lib/store.ts` throws `LockedError` before any request
  leaves. An earlier build pulled ciphertext, failed to read every record, and
  *still advanced the cursor past all of it* — leaving a signed-in user with
  an empty history above a revision the device would never ask for again.
  There is no cursor to strand now, and the failure mode has correspondingly
  shrunk to "this request does not happen", but the gate stays: writing
  through a missing key is what would put plaintext over ciphertext.
- **The session cookie is httpOnly and outlives local storage.** Clearing
  site data leaves someone authenticated and keyless. That is the `locked`
  state, and it needs its own UI — an empty transcript reads as lost data.
- **Remembering the vault key is a user choice, and remembered keys are
  account-scoped.** The default stores the non-extractable key in
  `dial-vault`, so refreshes remain unlocked. “Lock on exit” deletes it and
  keeps it in memory only. A legacy unscoped key must prove itself by opening
  sealed settings; if it cannot, delete it and enter `locked` before any write.
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
  width, density, device-key retention, OpenRouter key, **instructions**),
  encrypted whenever the account has a key. The model key is billable, so
  this blob is never stored in the clear. `instructions` is the system
  prompt for every conversation; it replaced the per-conversation prompt.
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
- `lib/store.ts` — the whole data layer, replacing `lib/db.ts` and
  `lib/sync.ts` together. Seal on write, open on read, R2 for anything heavy,
  and five requests. There is no cursor, no dirty flag, no merge.
- `lib/keystore.ts` — raw IndexedDB holding an account-scoped,
  **non-extractable `CryptoKey`** when the user chooses to remember this
  browser. This is the *only* remaining use of
  IndexedDB and it is deliberate: `localStorage` takes strings, so putting the
  key there would mean exporting the raw bytes and turning a key script can
  *use* into one it can *steal*. The memory-only alternative is a password
  prompt on every reload. It also deletes the legacy `dial` database on load, because
  leaving it would mean a browser quietly retaining a full plaintext copy of
  someone's history for as long as the profile lives.
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

- `lib/credentials.ts` — the user's OpenRouter key, held in memory for the
  life of the tab and written nowhere. It arrives from the sealed settings
  blob when the account is opened. The `CredentialStore` interface is gone
  along with the localStorage backing it abstracted over — the move it existed
  to anticipate has happened.
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
  the connect screen. Cached an hour in the **Cache API** — ~220KB of public
  data, which is an HTTP response with a TTL and therefore what that API is
  for and what `localStorage` is not. The old version stringified the parsed
  catalog and wrote it synchronously on the main thread.
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
- `lib/conversations.ts` — `useConversations()`, with the **same thirteen
  members and signatures** it had over Dexie. That is what kept `page.tsx` and
  `ChatView.tsx` (1,600 lines) almost unchanged through the inversion, and it
  is why the rework was tractable. `saveTurn` sends only what `contentKey`
  says changed, computes a `truncateFrom` from what has disappeared since the
  last write, and patches the in-memory list optimistically so the sidebar
  moves at the speed of the keyboard rather than the network. Titles are
  generated once per thread; a hand-typed rename sets `titleGenerated` and is
  never overwritten.
- `lib/credentials.ts` — the OpenRouter key, **in memory only**. Its own doc
  comment used to promise the backing store would move into the vault once
  accounts existed; it has. `dial:credential` held a billable API key as
  plaintext on disk, which was the worst thing in this app's storage.
- `lib/export.ts` — Markdown + JSON conversation export.
- `lib/sources.ts` — dedupe/label helpers for web-search sources. Tracking
  parameters, fragments, and trailing slashes are canonicalized so variants
  of the same page cannot become duplicate numbered citations.
- `components/settings/KeyGate.tsx` — the front door. OAuth first, paste
  second; the paste path exists because being locked out of your own history
  by an OAuth hiccup is not acceptable. A pasted key is verified against
  `/key` before it is stored, so a typo fails there with a reason instead of
  three screens later as a mystery stream error.
- **There is no `lib/preferences.ts`.** Session defaults, recent models, the
  open thread, and rail geometry were four separate `localStorage` keys; they
  are fields of the sealed settings blob now, so a preference set on the
  laptop is on the phone at the next load. Appearance is additionally mirrored
  to `dial:appearance` for the pre-paint script, and that mirror is the only
  thing in this app that reads `localStorage`.
- `app/page.tsx` — the shell. Owns catalog, active thread, settings.
  `view` (empty state) and `effective` (reconciled settings) are **derived
  during render**, not stored — writing them from effects cascades renders
  and trips `react-hooks/set-state-in-effect`.
- `components/chat/ChatView.tsx` — keyed per conversation. Stop (button +
  Esc), regenerate, edit-and-resend (truncate + resend), branch,
  jump-to-bottom, retry with a class-specific hint, and a **mid-stream
  snapshot every 1.2s** so closing the tab on a long answer no longer
  throws it away.
- `components/chat/Composer.tsx` — attach, the `@image` tool, and the
  effort control; nothing else. **Web search is not a control**:
  `reconcileSettings` sets `search` to whether the model can call tools, the
  tool is attached to every such turn, and the model decides when to search
  (before the catalog loads it is off, because offering tools to a model
  that cannot take them fails the request). **The system prompt is not here
  either** — it is the account's instructions, edited in Settings →
  Instructions and passed to the transport by ref. Send inverts to a stop
  square while busy.
- `components/chat/EffortControl.tsx` — the sparkle plus one word ("Medium",
  or a muted "Think" when off), opening a sliding segmented control of
  exactly the model's efforts with a one-line description of the selected
  level. Arrow keys move along it; Escape closes it without stopping a
  stream. It replaced a "Think · medium ⌄" dropdown.
- `components/chat/Metrics.tsx` — the per-message flight recorder. Collapsed
  = tok/s · duration · cost; expanded = provider, ttft, token split.
- `lib/timeline.ts` — `buildTimeline(message, { streaming, holdRemarks })`
  folds a turn into **one activity block, then the answer**. The work —
  thoughts, searches, and *remarks* (text the model said before going back to
  thinking or searching: "I'll look up both versions.") — are steps in stream
  order; the answer is the text after the last of it. While streaming, text
  with anything after it is a remark; once finished, the last run of text is
  the answer even if citations trail it. **While streaming with search on,
  short text right after the work is held** — shown nowhere until it passes
  `REMARK_MAX` (120 chars) or a second line, or more work lands behind it —
  because only then is it known to be the answer rather than a remark; without
  the hold every remark flashed as the answer and jumped into the activity a
  second later. Sources *with a position in the text*
  (`providerMetadata.openrouter.endIndex > 0`) are inline citations and never
  split the answer; search-round results arrive with `0/0`. Adjacent thoughts
  merge; whitespace-only text is dropped; `late-reasoning-*` parts from the
  first revival build are put back in order. The first activity block is
  always keyed `WORK_KEY`, from the empty placeholder on, so it never
  remounts. `answerTextOf` is what Copy copies. Pure and tested in
  `tests/timeline.test.ts`.
- `components/chat/Activity.tsx` — the activity block. **Live:** the header
  names what is happening now and rolls (`Swap`) when it changes — the
  thought's own section title when the model writes them (OpenAI and Gemini
  summaries: `**Checking the limits**`), "Searching the web" once a thought
  has *stopped* on a decision to search (judged after 700ms of quiet, never
  sentence by sentence — that flip-flopped), "Reading 5 sources" after
  results, else "Thinking" — with a live timer from the turn's start. Under it
  a seven-line window (`Reveal` in `follow` mode) shows the steps as they
  happen: traces type in with their newest words fading in (`StreamText`),
  results drop in one by one, older lines glide up under a fade. **Settled:**
  the window folds up into the header, "Thought for 4.3s · 3 sources".
  **Opened:** the same list at full height on a hairline rail — traces mono,
  titles and remarks sans, each search's results numbered within it, thoughts
  titled with their own duration (`DialMetadata.timings`, keyed by part id;
  turns without timings fall back to `thinkingMs`). The live list only ever
  grows at its end, so nothing above the newest line moves. The pre-reply
  placeholder (ChatView) is this component with no steps, at the same offset
  and with the reply's metrics row reserved, so the hand-off moves nothing.
  **There are no source chips under answers** — sources live here.
- `components/ui/Reveal.tsx` — a window onto bottom-growing content:
  `follow` (capped, anchored to the newest line), `full`, `none` (children
  unmount after the close). Growth is FLIP-glided — offset back by what it
  grew, animated to rest — with the frame's height on the same clock, so
  while the frame grows the two cancel and once it is full the text scrolls.
  Geometry is DOM writes, applied after every commit and on resize.
- `components/chat/StreamText.tsx` — append-only text rendered by its
  effect, not by React: each new piece is a `.dial-fresh` span that fades in
  and is folded back into a text node when its fade ends.
- `components/chat/MessageActions.tsx` — copy / edit / regenerate / branch,
  revealed on hover.
- `components/chat/MessageNavigator.tsx` — a container-aware transcript
  minimap beside the scrollbar. Compact markers use a springy proximity
  response (hovered, then neighboring bars), with no persistent single-marker
  highlight; hover/focus previews text, and click smooth-scrolls.
- `components/tuner/Palette.tsx` — **the one floating surface.** ⌘K opens it
  straight into model mode (the signature interaction must not cost an extra
  keystroke); typing `>` switches the same surface to commands. Arrow-key
  nav, recents, capability chips, a concrete `web` filter for models that can
  call the app's search tool, and the tuner-tick on select.
- `components/tuner/StatusStrip.tsx` — the readout the README always drew
  and never got built: model · thread cost · thread tokens · key balance.
- `components/sidebar/ConversationList.tsx` — brand, New chat, then a
  "Chats" header whose search control grows right-to-left into a
  title/model filter (Escape closes and clears it); date grouping, pin,
  export, rename, delete. **One line per row** — model and cost moved to the
  row's tooltip, and the open thread's totals are always in the status
  strip. The ellipsis overlays the title on hover and opens a pop-in menu;
  delete asks twice.
- `components/sidebar/RailHandle.tsx` / `RailToggle.tsx` — drag-to-resize
  (180–460px, double-click resets) and collapse (⌘B).
- `components/chat/SelectionActions.tsx` — select text inside one answer and
  a small bar offers Quote (into the composer as `> …`, ahead of any draft)
  and Copy. Waits for pointer-up, stays off touch screens, and ignores
  selections spanning messages.
- `components/ui/Segmented.tsx` — equal segments with a lifted thumb that
  slides to the selection; a real radio group (arrow keys move selection and
  focus). Used by settings and the effort control.
- `components/ui/Button.tsx` — pill buttons (`primary` inverted, `secondary`
  lifted, `ghost`, `quiet`) at three explicit heights. `buttonClass()` for
  anything that is not a `<button>`.
- `components/ui/GlideMenu.tsx` — the single gliding highlight; `hover` mode
  follows the pointer, `active` mode follows `data-glide-active` (the
  palette's keyboard cursor).
- `components/ui/Loader.tsx` — `PixelGrid`, `Elapsed`, and the two together.

### Rules learned the hard way

- **R2 has no per-prefix quota, so the total has to be carried in D1.**
  `blob_bytes` / `blob_count` on `user_state` are maintained on every put and
  delete. The put path subtracts the *previous* object's size first: blob ids
  are deterministic, so a re-sync overwrites rather than adds, and counting it
  as new would exhaust the quota while occupying one object's worth of space.
  Accounts predating the counters backfill themselves from one prefix list the
  first time settings is opened.
- **`atBottom` has to be recomputed on geometry change, not only on scroll.**
  Nudging the wheel a few pixels sets `stickRef` false while `atBottom` stays
  true; content then arrives from a sync, `followLatest` correctly declines to
  move, no scroll event fires, and the reader is stranded with nothing
  offering to take them to the bottom. `measureAtBottom` is a pure readout —
  it never writes `scrollTop` or `stickRef`, which is what keeps it clear of
  the follow hysteresis and the Safari fixes.
- **Selection painting: measure before believing.** Within a message every
  gesture — drag, double-click, triple-click — already paints tight to the
  glyphs in Chromium; the padding-on-the-wrapper rule is what buys that.
  A range spanning block boundaries paints full-width bands, and neither
  `user-select: none` on the wrappers nor `::selection { background:
  transparent }` fixes it: the first does not stop the range from spanning,
  and the second cascades into the text and kills the highlight entirely.
  Both were measured, not assumed. `getClientRects()` also reports rectangles
  the browser never paints, so screenshot the selection rather than trusting
  the geometry.

- **Retired — and the reason the architecture changed.** Four rules used to
  live here, and none of them is reachable now: a pull must never overwrite a
  row this device has not pushed yet; the pull cursor may only advance to a
  revision whose rows you have seen; an empty page must advance nothing; and a
  push may adopt its own revision only when it is exactly `cursor + 1`. Each
  was found the hard way, each was silent data loss, and each was the *same*
  bug in different clothes — two copies of the truth and a rule for
  reconciling them. Phase 13 deleted the second copy instead of getting the
  rules right a fifth time. If a future change proposes a local cache of
  conversations "just for offline" or "just for speed", this paragraph is the
  argument against it: the cache is the easy part and the reconciliation is
  what costs.
- **Allocate the revision *inside* the write batch, not before it.**
  `UPDATE … RETURNING` fixed concurrent allocation but stayed its own
  statement, so `user_state.rev` was briefly visible to a concurrent reader
  before the rows belonging to it existed. `batch` is one implicit
  transaction: put the UPDATE first and have the inserts read the revision
  back with `(SELECT rev FROM user_state WHERE user_id = ?)`. That closes the
  window and removes a D1 round trip from the hottest write path. When the
  state row is gone the inserts have no revision to read and the NOT NULL
  constraint rolls the whole transaction back — catch it and return 401, or a
  deleted account fails open with a 500.
- **Per-request limits bound nothing cumulative.** The blob quota exists
  because R2 needed a ceiling; D1 needed one too and did not have it, so an
  authenticated client looping `/v1/sync` could spend the deployment's whole
  daily row-write allowance. `writes_day` / `writes_today` are advanced by the
  same UPDATE that allocates the revision, and enforced against the state row
  the request already loaded — a bounded ceiling for no extra statement and no
  extra CPU.
- **`react-syntax-highlighter`'s default `Prism` export is `refractor/all`.**
  297 grammars, 1.87 MB raw and 557 KB gzipped, in a chunk `index.html` loads
  eagerly — three quarters of this app's entire first-load JavaScript, to
  colour the dozen languages a chat answer contains. `PrismLight` plus the
  curated `GRAMMARS` list in `lib/syntax.ts` registers them asynchronously
  after boot: 31 lazy chunks totalling 51 KB gzipped, none of them eager.
  Anything unregistered falls through the library's own try/catch and renders
  as plain monospace, which is what an unknown fence always did. **Measure the
  built chunks before and after** — splitting `lib/transport.ts` out looked
  like the same kind of win and made the eager bundle *larger*, because
  `@ai-sdk/react` already pulls that graph and Turbopack duplicated it.
- **react-markdown memoizes nothing.** It runs remark-parse → remark-gfm →
  remark-rehype → element creation inside its own render, measured at 2.4 ms
  for a 17 KB answer, and an inline `components` object guaranteed a fresh
  subtree on top. The transcript re-renders on every streamed token, so a long
  thread spent tens of milliseconds per token re-parsing messages nobody had
  touched. `Markdown` is `memo`'d on its only prop and the component map is
  hoisted to module scope; a finished message now parses exactly once.
- **Content-hashed assets were being revalidated on every load.** Workers
  Assets serves everything `max-age=0, must-revalidate` by default, so all
  nine entry scripts made a conditional round trip before hydration for bytes
  the browser already had. `/_next/static/*` is immutable by construction —
  the hash is in the filename — and now says so in `public/_headers`. Scoped
  to that directory on purpose: the HTML must keep revalidating or a deploy
  never reaches anyone holding a cached page.
- **Refresh the rail on what actually changed, not on the sync status.**
  Status settles on every reconciliation and most apply nothing; a streaming
  turn wrote about every five seconds, so watching it re-read the whole
  conversations table and replaced the array — re-rendering the entire rail —
  several times per answer to learn nothing had changed. The delta now returns
  the changed thread rows themselves and `applyDelta` patches them into the
  list, so a refresh costs one map write per moved thread and no query at all.
- **A revision must be allocated by the database, not derived from a read.**
  `push` computed `state.rev + 1` from a row read earlier in the request, so
  two devices pushing at once both wrote the same revision — and a third
  device that pulled between the two writes advanced its cursor past it and
  never asked for the second batch again. `UPDATE … RETURNING rev` is the fix.
  Realtime is what turned this from theoretical into routine, because it made
  two devices online at the same time the normal case.
- **A short page is not the last page.** `PAGE_SIZE > MAX_PUSH_RECORDS` is
  retired with the cursor it protected, but the shape of that bug came back
  immediately in a new form: the server ends a message page early when the
  payloads reach its byte budget, so a page of 12 rows out of a 200-row limit
  is routine on a thread of long answers. Paging is therefore resumed from the
  last `seq` seen, never from an offset or a row count — the two limits
  disagree and only `seq` satisfies both.
- **Never echo a revision to the device that caused it.** The hub fans out to
  every socket; before the connection-id tag, a device pushing mid-stream woke
  itself, found the rows its own 1.2s snapshot had just re-dirtied, pushed
  again, and looped at round-trip speed.
- **A remote change is invisible until something re-reads it.** The rail
  refreshed and the open transcript did not, which is the whole reason
  cross-device sync looked broken while it was working perfectly. ChatView
  adopts remote changes, but never while busy or saving, never after a failed
  save, never twice for the same version, and never when the stored copy is
  missing a message it is holding (that means our own save is still in
  flight). The cost of the last guard is
  that a *truncation* made elsewhere waits for a thread switch; losing a
  locally streamed answer would be worse. `pulled` now increments only when
  the delta says the *open* thread moved — a write to some other conversation
  must not make the transcript in front of the reader re-read itself.
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
- **Local durability and cloud freshness used to be different clocks; now
  there is one.** The 1.2s snapshot existed so a closed tab could not lose a
  long answer to IndexedDB, and `DRAFT_SYNC_MS` throttled the *cloud* push to
  ~5s on top of it. With no local store the throttle carries the durability
  itself, so the shape changed: the first checkpoint of a turn is written
  immediately (`lastDraftRef` is reset by every settled save) and only the
  ones after it are throttled. Closing the tab early costs about a second of
  an answer; closing it late costs at most five. ChatView still ticks at 1.2s
  and `saveTurn` decides whether that tick becomes a request.
- **A streaming checkpoint and the final save must never race.** Sealing and
  R2 spill uploads are asynchronous, so starting the final save second did not
  guarantee it reached D1 second. One older half-answer landed last, gained the
  newest revision, and realtime correctly pulled the regression over the
  complete in-memory text. `saveTurn` now serializes writes per thread;
  `onFinish` synchronously closes the draft gate; ChatView defers remote reads
  while a save is pending or failed; and local commits advance `revRef` so this
  device does not classify its own checkpoints as remote edits.
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
- **Some models answer on the reasoning channel.** Kimi K2.5 does it
  routinely: the whole reply streams as reasoning tokens and content never
  opens (OpenRouterTeam/ai-sdk-provider#426 — the provider relays it
  faithfully, so it is ours to handle). The transcript showed "Thought for
  40s" over nothing, with the answer folded inside the collapsed trace.
  `promoteReasoningAnswer` in `lib/messages.ts` moves the trace into a text
  part when a turn *finished normally* with reasoning and no text — never on
  `length`, `error`, `tool-calls`, an abort, or a stream that never reached
  its finish, where the trace is a half-thought. It runs in three places that
  must stay in agreement: ChatView's `onFinish` (so the saved turn is right),
  MessageBubble's render (for turns saved before it existed), and
  `messagesForTextModel` (so the next request carries the answer as assistant
  text instead of reasoning many models strip). The flight recorder marks it
  (`answerInReasoning`). While any model thinks, the newest two lines of the
  trace show under the header, so a long think never reads as a hang.
- **OpenRouter's search loop sends thinking in blocks, after silence.** With
  the `openrouter:web_search` server tool the model's rounds run inside
  OpenRouter: each round's reasoning arrives whole once the round ends (800 to
  6,400 characters), the results a second or two later, then nothing for
  2–26s (measured on DeepSeek V4.1 Flash and Kimi K2.6), and the answer's
  chunks can land within 150ms. Two consequences. Timing a thought
  first-token-to-last-token read "Thought for 1ms", so a thought starts at the
  *previous event* (results, text) unless it is the turn's first and genuinely
  streamed — see the transport's `reasoning-end` case. And rendering blocks as
  they came read as freeze-then-jump, which is what `lib/smooth-stream.ts` is
  for: each burst is spread over the silence before it (an average of recent
  gaps; 150ms–1s for text, up to 4s for thinking, which nobody is waiting to
  read). Results queued behind a thought wait for it to finish typing; an
  answer queued behind thinking (past `REMARK_MAX`, or a second line — a
  shorter line may be a held remark) catches it up within 600ms; the end of
  the stream within 200ms; abort and error flush at once. A new arrival
  extends the reveal but never cuts one short, and each tick's text goes out
  as one merged delta. **Silence is measured between chunks that carry
  something** — `reasoning-start` arrives a millisecond before its block, and
  counting it made every block look like it followed no pause. It runs
  *after* the flight recorder, so measurements are taken on arrival. Tested in
  `tests/smooth-stream.test.ts`.
- **A restarted Web Animation holds its first frame.** `element.animate()`
  is play-pending until the compositor starts it, and holds its first
  keyframe meanwhile. `Reveal` restarts its glide on every streamed line —
  every other frame in a fast stream — so the content froze half the time: a
  30Hz judder, found by sampling positions frame by frame (55 of 149 frames
  frozen in Kimi's largest block). Setting `startTime` to
  `document.timeline.currentTime` skips the pending state and starts the
  animation one frame along; `currentTime` alone did not. Glides also use a
  curve that starts linear (`cubic-bezier(0.3, 0.3, 0.4, 1)`): a strong
  ease-out restarted per line is fast-slow-fast, a stutter of its own.
- **A streamed token must re-render one message, not the thread.** Every
  chunk re-rendered every MessageBubble — timeline, metrics, sources — and
  `toLocaleTimeString` built a new `Intl.DateTimeFormat` for each timestamp on
  each render. On a 30-message thread with a 4× throttled CPU that froze the
  page for up to 1.85s at a time (main thread busy 7.5s of 9). Now
  MessageBubble is `memo`'d with index-taking callbacks ChatView keeps stable
  through a ref, `useChat` is `throttle: 33`, and `formatTime` caches its
  formatter: 0.9s of script, no frame over 17ms. Measure with CPU throttling
  in a production build — an unthrottled fast Mac drops no frames either way
  and hides all of this.
- **A part sits where it *started*.** useChat appends a part on its start
  chunk and grows it in place, so a part opened early keeps every later token
  at its early position — and whatever arrived in between reads as if it came
  after. `orderStream` in `lib/reasoning-stream.ts` runs over `fullStream`
  (with `includeRawChunks`) and makes array order equal time order. Four
  provider behaviours needed it, all tested in
  `tests/reasoning-stream.test.ts`:
  - *It drops reasoning once content opens — even a lone newline.*
    `@openrouter/ai-sdk-provider` stops emitting reasoning at the first truthy
    `delta.content`, and some models send `"\n\n"` mid-thought: the header
    flipped to "Thought for 0.7s" while the model went on thinking unseen.
    Raw chunks arrive *ahead of* the parts derived from them, so the
    reasoning it is about to discard is re-emitted (`reasoning-resumed-*`)
    — only after the provider has opened text, or it would double.
  - *Whitespace opens a text part.* It is buffered until real text arrives
    and dropped if none does, so a newline never becomes an empty answer
    above the thinking it interrupted.
  - *Text resumes under its old id.* Reasoning after real text closes the
    open text part; the next text gets a new id and lands below the thought.
  - *A thought spans a search.* The provider keeps one reasoning part open
    from first thinking token to first answer token, so thinking resumed
    after the results grew the thought above them. A source mid-thought marks
    it interrupted; more reasoning then splits it. If none follows nothing is
    split, so the provider's closing metadata (reasoning signatures, sent back
    on later turns) stays on the part it belongs to.
  Sources never split text — annotations ride with content chunks. If the
  provider is upgraded, re-check each of these before deleting any.
- **Nested GlideMenus must ignore each other's rows.** A row menu inside the
  rail is a GlideMenu inside a GlideMenu, and pointer events bubble — the
  rail's highlight slid behind the popover to the hovered item's height. A
  menu only tracks rows whose nearest `[data-glide-menu]` is itself.
- **Favicons are cached by site, not by URL query.** After the mark changed,
  browsers that had the create-next-app default kept showing it, because the
  `app/icon.*` convention only changes a query string. Icons live at
  versioned paths in `public/brand/` and are declared in `layout.tsx`
  metadata; bump the `-v` suffix whenever the mark changes.
- **`0 && …` renders a literal 0.** The status strip printed a stray "0" for a
  thread whose cost and tokens were both zero. Coerce with `Boolean()` when
  the left side is a number.
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
- **A double-click on nothing selects a newline.** In a user bubble
  (`whitespace-pre-wrap`), double-clicking the blank line between paragraphs,
  past the end of a line or in the padding selected the newline there and
  painted a stray bar in empty space; a triple-click ran the range out of the
  bubble into the next message, which WebKit paints as bands across the gap.
  `selectBubbleText` in MessageBubble keeps the browser's word selection for
  a double-click *on a glyph* (hit-tested with `caretPositionFromPoint` and
  the glyph's own rect) and otherwise selects exactly the message's text. It
  re-applies after mouseup, because a press inside an existing selection
  defers that selection's collapse to the release. Verified by
  `getSelection().toString()`, not by eye — the spill was invisible in
  Chromium and still four newlines long.
- **Padding belongs on the wrapper, not on the element holding the text.** A
  selection highlights whole line boxes, so a padded `<p>` highlights 16px of
  empty space before the first character and after the last — a message
  selected by double-click looked like a band of grey around the words.
- **No focus ring on text fields.** The caret is the affordance; a box around
  the borderless composer textarea reads as a stray outline.
- **The rail sits on the page; the chat window is the lifted surface.** A
  card around the rail as well made two competing windows, and glass on a
  pinned sidebar reads as a different application.
- **Hidden controls must not reserve space.** The user bubble's hover
  actions sit absolutely in the row gap; reserving a line for them pushed
  every answer a full row away from its question.
- **The front door is the whole page.** Sign-in, unlock and connect-a-key
  render in `components/settings/FrontDoor.tsx` with no rail and no status
  strip — the shell used to render around them, offering "new chat" and a
  model switcher that did nothing until the gate was passed. The inner gates
  carry "signed in as … · Sign out" in the footer, because the account
  button is not there to do it.
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
- **Never put the user's key in a field yourself, and never on disk.**
  It lived in `localStorage` while sync was optional, on the reasoning that a
  key in a synced table is a key in someone's cloud. That reasoning inverted
  once the settings blob became ciphertext the server cannot read: the safe
  place is the sealed blob, and the unsafe place is the disk.
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
  payloads spill to R2, PDF input via OpenRouter's file-parser) ·
  **13 cloud-first ✓** (Dexie and `lib/sync.ts` deleted, typed `thread` /
  `message` tables replace the opaque record store, five REST endpoints
  replace pull/push, forced login, every preference moved into the sealed
  settings blob, one localStorage key left). ·
  **14 interface pass ✓** (Beautiful UI's structure in a monochrome palette:
  solid hairlines and layered shadows, flush rail and lifted chat window,
  gliding highlights, pixel-grid loaders, full-page front door, greeting
  empty state with a docked composer, source chips, selection quoting). ·
  **15 timeline ✓** (reasoning and search as one chronological activity
  timeline with per-step timings, automatic web search, account-wide
  instructions in settings, the effort control, exact bubble selection,
  moved to chat.belayet.app) · **16 work, then answer ✓** (remarks fold into
  the activity, per-step timings from observed events, `smoothStream`,
  memoized bubbles and a throttled transcript, no source chips) · **17 flow ✓**
  (the live activity window, rolling labels from the model's own titles,
  remarks held until they are known, judder-free glides, a seamless
  placeholder hand-off). Next product work: sub-agent delegation and
  per-thread temperature (the wire already carries it).
## Design system (the law)

**Strictly black, white, neutral gray interface chrome — both themes, no
accent color.** Every token has zero chroma. State is shown by **fill**:
a binary switch that is on (the `@image` tool, the send button) is an
**inversion** — a filled, contrast-swapped block; a selection among peers
(the open thread, a segmented option, the effort control) is a
**quiet fill or a lifted thumb**, because a permanently inverted block would
be the loudest thing on screen. Syntax highlighting is the sole functional
exception to monochrome. No default shadcn look, no purple gradients, no
generic dark+neon SaaS aesthetic.

The structure — solid hairlines, a layered shadow scale, tight radii, strong
ease-out curves, gliding highlights — is adapted from **Beautiful UI**
(beautifului.dev, MIT, © 2026 Shane Levine). Its palette is not: it tints
neutrals blue and keeps a blue accent, and both were dropped. It is a
reference, not a dependency — its components pull in `clsx`,
`tailwind-merge`, `class-variance-authority`, `iconoir-react` and a paid
icon set, and none of those were added. Ported pieces carry an attribution
comment.

- **Surfaces** (tokens in `app/globals.css`): `chrome` is the page and the
  rail sits directly on it; `background` is the chat window, the one lifted
  surface (`shadow-window`); `panel` is every solid floating surface —
  composer, menus, dialogs, cards; `field` is inputs and the user's own
  bubble; `hover` / `hover-2` are translucent row fills. Dark: chrome
  `#0E0E0E` · window `#141414` · panel `#1A1A1A` · field `#1F1F1F` · line
  `#242424` · fg `#F2F2F2` · muted `#878787`. Light: chrome `#F1F1F1` ·
  window `#FCFCFC` · panel `#FFF` · field `#F4F4F4` · line `#E8E8E8` · fg
  `#111` · muted `#767676`. Muted differs per theme on purpose: it carries
  small mono metadata and has to clear ~4.5:1 on each window colour.
- **Edges are solid, not alpha.** `line` / `line-strong` for dividers; the
  `shadow-*` scale (`hairline · btn · card · raised · overlay · window`) is a
  1px ring plus soft layered stacks. In dark mode the ring becomes a faint
  *light* edge so it reads against the shadow. No backdrop blur on surfaces —
  the old glass was replaced by solid panels; overlays dim with `bg-black/30`
  and a 2px blur only.
- **Radii:** `rounded-chip` 6 · `rounded-control` 8 · `rounded-card` 10 ·
  `rounded-window` 14 · pills `rounded-full`. The composer (20px) and user
  bubble (18px, 6px tail corner) are the deliberate exceptions.
- **Type split:** Geist Mono for anything the system *measured* (model
  slug, tok/s, latency, timestamps, costs, reasoning trace); Geist Sans for
  anything a person *authored* — messages, and interface labels and buttons,
  which are sentence case ("Sign out", "Retry"). Numbers/process = mono,
  content and controls = sans.
- **Layout:** centered reading column (`--dial-column`, 760px by default).
  Assistant messages get **no bubble** — bare text on the page. User
  messages are the only bubbles, right-aligned. This asymmetry is deliberate.
- **Signature control:** the sticky top "tuner strip" — model switcher
  styled as a channel readout, not a dropdown. Its palette select animation
  (damped ~200ms with slight overshoot, a filled block inverting into place)
  is the one place motion may be expressive.
- **One highlight per list.** Menus, the rail and the palette use
  `components/ui/GlideMenu.tsx`: a single fill glides between rows instead
  of each row painting its own hover. Geometry is written to the DOM, never
  React state — a pointer crossing a long rail must not re-render it.
- **Code gets restrained semantic color.** `lib/syntax.ts` uses low-chroma,
  theme-aware token colors while the surrounding interface remains neutral.
  Every fenced block collapses from its header, which shows the language and
  a labelled Copy. `::selection` is a gray tint (`--selection`), not the
  browser's blue and not a full inversion — an inverted block across a long
  selection was the heaviest thing on the page and flattened code colours.
  Keyboard focus is a visible 1.5px `muted` outline offset 2px; text fields
  are the exception (the caret is the affordance).
- **Work with no progress to show** gets `components/ui/Loader.tsx`: a 3×3
  pixel grid with a chevron wavefront, a shimmering label, and a live mono
  timer anchored to a real start time. Used for the gap before the first
  token, live thinking, image renders, and session resolution.
- **Motion elsewhere is quiet:** messages fade + 4px slide-up 150ms;
  popovers pop in from their anchor (scale 0.96 → 1, 160–200ms, strong
  ease-out); presses scale to 0.97. Streaming shows **one small breathing
  mark at the live edge** of the last paragraph — solid, not blinking, and
  not a caret (nothing is being typed); no typewriter. The answer fades in
  once as the work folds away above it; inside the live activity window the
  newest words fade in and lines glide rather than jump. A label that
  changes rolls (out up, in from below) and the row eases to its new width.
  Always respect `prefers-reduced-motion`.
- **Theme toggle** swaps instantly — no cross-fade. `color-scheme` follows
  the theme so native controls (date picker, autofill) match.

## Hard constraints / non-goals

- **Repealed (was a v1 non-goal):** no auth, no server storage, no sync.
  All three now exist.
- **Repealed (was the v3 law):** "Dexie remains the source of truth and cloud
  sync is a replica of it — never the other way round." The inversion is the
  whole of phase 13. **D1 is the source of truth**; the browser holds the open
  thread and the sidebar in memory and nothing on disk. Reintroducing a local
  copy of conversations would reintroduce the reconciliation problem that
  caused three separate data-loss bugs, and it is a regression.
- **Repealed (was a v3 non-goal):** "Cloud sync is optional and must stay
  optional… anything that turns it into a login wall is a regression." It is
  a login wall now, deliberately. There is no local store to fall back on, so
  an unauthenticated visitor has no app to show.
- **The browser stores exactly three kinds of things, and none of them is a
  conversation.** One `localStorage` key (`dial:appearance` — appearance,
  rail geometry, and the non-sensitive remember/lock preference), an optional
  account-scoped IndexedDB record (the non-extractable vault key, because no
  other web storage can hold one safely), and the Cache API copy of
  OpenRouter's public model catalog. Adding a fourth
  needs a reason that survives the question "what happens when this disagrees
  with the server?"
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

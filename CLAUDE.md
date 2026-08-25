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
- `.gitignore` has `.env*` — `.env.local` carries the key, never commit it.
- To test the stream without a browser:
  `curl.exe -sS -N -X POST localhost:PORT/api/chat -H "Content-Type: application/json" --data-binary @file.json`

## Architecture

The organizing idea after the v2 rework: **the app measures what it does.**
Every assistant message carries a flight recorder, and the model catalog
carries a capability surface — so the mono readouts have real numbers and
the controls can't offer something the model won't honour.

### Backend (thin, validated, instrumented)

- `lib/openrouter.ts` — the only place `createOpenRouter()` is built.
  Server-only; `appUrl` reads `OPENROUTER_APP_URL`. Per-request concerns
  (reasoning, web_search, usage accounting) are set at the call site.
- `lib/catalog.ts` — **server-only**, imported only from route handlers.
  Fetches `/models`, normalizes it, and derives `ModelCapabilities`
  (vision / tools / reasoning + `supported_efforts` + `default_effort` +
  `mandatory`). Anything not positively advertised is treated as
  unsupported. Cached 1h via the Next fetch cache.
- `lib/schema.ts` — zod request schemas (this is what `zod` is for; it was
  a dependency with no importer before). Bad requests get a real 400 with
  a reason, not silent coercion.
- `app/api/chat/route.ts` — POST. Validates, strips client system messages,
  injects the server-held system prompt, forwards `abortSignal: req.signal`
  so an abandoned stream stops billing. Builds the model with
  `openrouter(model, { usage: { include: true } })` — that flag is what
  makes **real USD cost** available instead of an estimate. Streams
  `DialMetadata` incrementally via `messageMetadata`, which the AI SDK
  merges client-side:
    `start` → model/effort/search/startedAt ·
    first delta → `ttftMs` ·
    `finish-step` → routed provider + usage accounting (cost, cached,
    reasoning tokens) ·
    `finish` → duration, tok/s, finishReason, token split.
- `app/api/models/route.ts` — GET, the normalized capability-bearing catalog.
- `app/api/title/route.ts` — POST, names a thread with a cheap model
  (`OPENROUTER_TITLE_MODEL`). Best-effort: failure keeps the local fallback.
- `app/api/key/route.ts` — GET, OpenRouter key balance for the strip.
- `app/api/image/route.ts` — POST, executes the `@image` tool through
  OpenRouter's dedicated Images API. A selected model whose catalog output
  modalities include `image` is honored; optional `OPENROUTER_IMAGE_MODEL` is
  the fallback. Output cost is measured upstream and images return as data URLs
  for local persistence.

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

- **The shell mints the conversation id, including for unsaved threads.** If
  ChatView minted its own and `onFinish` flipped `activeId` before the save
  landed, the chat's key changed mid-write, ChatView remounted, and the shell
  re-read an empty thread out of Dexie — the first exchange vanished a beat
  after it arrived. Save first, announce second, and never let the key change.
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
- **No focus ring on text fields.** The caret is the affordance; a box around
  the borderless composer textarea reads as a stray outline.
- **The rail shares the transcript's ground.** Glass is for things that
  float; `bg-surface` on a pinned sidebar reads as a different application.
- **Validate model ids against the *catalog*, not against intuition.**
  `MODEL_ID_PATTERN` has to accept everything `/api/models` will offer, or the
  switcher lists models the route then 400s on. OpenRouter publishes floating
  aliases prefixed with `~` (`~anthropic/claude-sonnet-latest`) — twelve of
  them. If the pattern changes, re-run it over the live catalog.
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
  7 next: vision/attachments for `capabilities.vision` models, sub-agent
  delegation, per-thread temperature (the wire already carries it).
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

## Hard constraints / non-goals (v1)

- No auth/accounts, no server DB, no cross-device sync. Storage =
  IndexedDB via Dexie (Phase 4), entirely client-side.
- No billing/usage limits. No open-ended agentic tools beyond web search
  and (exploratory) model delegation — no file access, code execution, or
  general browsing. No voice.
- Reasoning comes back as a distinct `reasoning` part — use the part type,
  don't hand-parse it out of the answer.
- Web search uses the `openrouter:web_search` server tool (the model
  decides when to search) — **not** the deprecated `:online` slug suffix.

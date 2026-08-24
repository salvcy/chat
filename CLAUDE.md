@AGENTS.md

# Dial — project law for future sessions

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

- Use `pnpm.cmd` / `npm.cmd` (this Windows machine's PowerShell execution
  policy blocks the `.ps1` shims).
- `.gitignore` has `.env*` — `.env.local` carries the key, never commit it.
- To test the stream without a browser:
  `curl.exe -sS -N -X POST localhost:PORT/api/chat -H "Content-Type: application/json" --data-binary @file.json`

## Architecture

- `lib/openrouter.ts` — `createOpenRouter()` wrapper + `openrouter.tools.webSearch`
  (the only place the provider is built). Reasoning + the web_search server
  tool are passed on the `streamText` call in the route, not here.
- `lib/types.ts` — shared types + `DEFAULT_MODEL` (client-safe, no
  server imports). `lib/format.ts` — pricing/context display helpers.
- `lib/db.ts` — Dexie (`"use client"`): `conversations` (id, title,
  model, reasoning, search, createdAt, updatedAt) + `messages`
  (UIMessage & {conversationId}), v1 schema. `deriveTitle()` = first
  user text, 80 chars.
- `lib/conversations.ts` — `useConversations()` (Dexie-backed list, active
  id, persist/loadMessages/rename/remove) + `makeOnFinish()` (persists the
  finished conversation: assigns a conversation id, `bulkPut`s messages).
- `app/api/chat/route.ts` — POST, thin proxy: `streamText` →
  `toUIMessageStreamResponse({ sendSources: true })`. Body: `model`
  (validated `provider/slug[:variant]`, falls back to `DEFAULT_MODEL`),
  `reasoning` ("off"|"low"|"medium"|"high" → `providerOptions.openrouter.reasoning`),
  `search` (boolean → `tools: { web_search: openrouter.tools.webSearch({}) }`).
  Client-sent system messages are stripped. The OpenRouter key **never**
  reaches the client (`OPENROUTER_API_KEY` is server-only).
- `app/api/models/route.ts` — GET, live OpenRouter catalog trimmed to
  `{id, name, contextLength, promptPrice, completionPrice}`, upstream
  fetch cached 1h (`next: { revalidate: 3600 }`).
- `app/page.tsx` — chat view: `useChat({id: activeId ?? undefined, onFinish})`
  + `DefaultChatTransport` at `/api/chat`, per-send `body: {model, reasoning, search}`;
  `useConversations()` drives the sidebar; on conversation switch it loads
  persisted messages + settings; on finish `makeOnFinish` writes back to Dexie.
  Layout: fixed flex shell (`h-full overflow-hidden`); the transcript is the
  ONLY scrolling region (`dial-scroll`), so the sidebar never scrolls with chat.
  Auto-scroll sticks to bottom on stream unless the user scrolls up (>80px).
  `app/layout.tsx` body is `h-full` (needed for the flex shell).
- `components/chat/Composer.tsx` — THE composer, the one persistent object:
  floating glass capsule (rounded-[24px], surface + blur + soft shadow).
  Borderless auto-growing textarea; footer row holds the model tuner (opens
  ModelSwitcher, ⌘K) + reasoning + search as glass Dropdowns; Enter sends,
  Shift+Enter newline; send is a circle that inverts only with content.
- `components/ui/Dropdown.tsx` — minimal glass menu: mono trigger showing the
  value, options float above (inverts the active one), closes on outside/Esc.
- `components/tuner/ThemeToggle.tsx` — sun/moon glyph (top-right); instant
  swap via an injected `transition:none!important` style removed after two
  frames; persisted to `localStorage("dial:theme")`; pre-paint boot script in
  `app/layout.tsx` (`suppressHydrationWarning` on `<html>`) — keep key in sync.
- `components/tuner/ModelSwitcher.tsx` — glass palette (rounded-2xl,
  bg-background/80 + blur, scrim) + the tuner-tick: on select a
  `bg-invert-fill` block sweeps the row (200ms, `ease:[0.16,1.4,0.32,1]`).
- `components/chat/MessageBubble.tsx` — part dispatcher: assistant = bare
  Markdown prose (no bubble), user = right glass pill (rounded-br tail) +
  mono timestamp; reasoning → ReasoningPanel; source-url → SearchPanel +
  Citations footnotes.
- `components/chat/Markdown.tsx` — react-markdown + remark-gfm +
  react-syntax-highlighter (oneDark); monochrome, hairline-framed code blocks
  with a mono language label; inline code = hairline chip.
- `components/chat/ReasoningPanel.tsx` — telemetry trace; while streaming the
  header glows via `.dial-shimmer` (side-to-side gradient) + pulsing dots;
  auto-collapses when the answer starts (render-time state, not an effect);
  collapsible trace is mono/muted with a hairline left edge, internal scroll.
- `components/chat/SearchPanel.tsx` — web-search telemetry, source-driven:
  `web_search` is provider-executed so only `source-url` parts stream back;
  header shows shimmering "searching the web…" while streaming with no answer,
  then lists sources (title · domain), collapsible. (Note: provider excerpts
  can be garbled UTF-8 — title is preferred, domain is the fallback.)
- `components/chat/Citations.tsx` — hairline footnote block, numbered,
  text-only links (title · domain), no favicons/cards.
- `components/sidebar/ConversationList.tsx` — glass rail with the "dial"
  wordmark + a hairline "+ " button; threads are quiet rows, the active one
  is the single inverted row; hover ✎/✕ (rename inline / click-confirm delete).
  Desktop-only (`hidden md:block`); on mobile it's a glass drawer from the ≡ button.
- `styles/` — reserved; tokens currently in `app/globals.css` (which also
  holds the global `prefers-reduced-motion` kill-switch, the `.dial-shimmer`
  keyframes, and the `.dial-scroll` thin scrollbar).
- Motion (Phase 5 ✓): message enter = fade + 4px slide-up 150ms ease-out
  (`motion.div` in MessageBubble); streaming = 120ms opacity ramp per part;
  tuner-tick as above; dropdowns/panels = 140–200ms ease-out; shimmer for
  live reasoning/search; everything else stays quiet.
- Roadmap phases: 0 scaffold ✓ · 1 core loop ✓ (hardcoded
  `anthropic/claude-sonnet-4.6`) · 2 model switcher ✓ (live catalog,
  searchable, pricing) · 3 reasoning + web search ✓ (effort cycle
  off/low/medium/high + `web_search` server tool, citations as
  `source-url` footnotes) · 4 persistence + sidebar ✓ (Dexie schema,
  per-conversation model/reasoning/search, rename/delete) ·
  5 design pass ✓ (glass panels, theme toggle, tuner-tick, quiet motion,
  mobile drawer) · 6 stretch. Build phase-by-phase; install each phase's
  deps at that phase, not ahead.

## Design system (the law)

**Strictly black, white, neutral gray — both themes, no hue, no accent
color anywhere.** State is shown by **inversion** (filled contrast-swapped
element), not color. No default shadcn look, no purple gradients, no
generic dark+neon SaaS aesthetic.

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

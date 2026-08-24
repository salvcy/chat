# Dial

*A minimal chat interface for every model, through one key.*

Working title — rename freely, it's a global find-replace.

## What this is

A personal, single-user web app for chatting with any LLM through OpenRouter's unified API, wrapped in an interface that's quieter and more considered than the default ChatGPT-clone look. One key, every model, no bloat.

## Assumptions

Stated up front so they can be overturned before any code gets written:

- **Single user, no auth.** This is a personal tool, not a SaaS. No login, no multi-tenant data model.
- **Local-first storage.** Conversations live in the browser (IndexedDB), not a server database. No sync service in v1.
- **Vercel deploy target.** Next.js on Vercel is the default; Cloudflare Pages is a fine alternative if you'd rather keep everything in one hosting ecosystem, but it changes the streaming setup slightly.
- **Black and white, both themes, no exceptions.** Dark and light mode both ship in v1. Neither has a color accent — the palette is strictly black, white, and neutral gray in both.

## Tech stack

**Frontend**
- Next.js 16 (App Router, Turbopack, React 19) + TypeScript
- Tailwind CSS v4
- Framer Motion — used sparingly, for the message-entry animation and the tuner-tick (see Design System)
- `@ai-sdk/react` (`useChat`) for streaming message state

**Backend**
- Next.js Route Handlers as a thin proxy (`app/api/chat`, `app/api/models`) — the OpenRouter key never reaches the client
- Vercel AI SDK (`ai`, v7) + `@openrouter/ai-sdk-provider` (the official OpenRouter provider) for `streamText`
- OpenRouter's model catalog (`GET https://openrouter.ai/api/v1/models`) fetched server-side, cached, and used to populate the model switcher — don't hardcode a model list
- **Reasoning**: OpenRouter's unified `reasoning` param (`{ effort: "low"|"medium"|"high" }` or `{ max_tokens }`, model-dependent). The AI SDK surfaces this as a distinct `reasoning` part alongside `text` parts on the message — don't hand-parse it out of the answer, use the part type
- **Real-time search**: the `openrouter:web_search` server tool added to the request's `tools` array — this is the current recommended method (the model decides when to search) over the deprecated `:online` model-slug suffix. Sources come back as `url_citation` annotations

**Storage**
- Dexie.js over IndexedDB for conversations + messages, entirely client-side
- No Postgres/Supabase/Prisma in v1. Add a real database only when cross-device sync becomes an actual need, not a hypothetical one

**Deploy**
- Vercel. `OPENROUTER_API_KEY` is a server-only environment variable — never prefixed `NEXT_PUBLIC_*`

Package versions move fast; confirm current major versions at scaffold time rather than trusting this doc verbatim.

## Design system

The organizing idea: this app's whole point is tuning into different models through one interface — so the interface should feel like a precision instrument, not a generic chat template. Glass surfaces (soft, translucent, Apple-adjacent) over an instrument-panel information language (mono readouts for the things a gauge would show: model, tokens/sec, latency).

The palette is strictly black, white, and neutral gray — no hue, warm or cool, in either theme. There is no accent color anywhere. Where a normal design system would reach for color to signal "active" or "enabled," this one reaches for **inversion** instead: a filled, contrast-swapped element is the entire vocabulary for state. That's the one rule everything else below follows.

**Palette — dark**

| Token | Value | Role |
|---|---|---|
| Void | `#0A0A0A` | Background |
| Surface | `rgba(255,255,255,0.06)` + `backdrop-blur(20px)` | Glass panels — tuner strip, input bar, user bubbles |
| Foreground | `#F5F5F5` | Primary text |
| Muted | `#8A8A8A` | Secondary text, timestamps, telemetry |
| Hairline | `rgba(255,255,255,0.10)` | Borders, dividers — 1px, never heavier |
| Invert | `#FFFFFF` fill / `#0A0A0A` text | The active-state device — send button with content, an enabled toggle, the tuner strip while streaming |

**Palette — light**

| Token | Value | Role |
|---|---|---|
| Paper | `#FAFAFA` | Background |
| Surface | `rgba(0,0,0,0.04)` + `backdrop-blur(20px)` | Glass panels |
| Foreground | `#0A0A0A` | Primary text |
| Muted | `#8A8A8A` | Secondary text, timestamps, telemetry — same value both themes |
| Hairline | `rgba(0,0,0,0.10)` | Borders, dividers |
| Invert | `#0A0A0A` fill / `#FAFAFA` text | The active-state device |

A theme toggle sits next to the gear icon in the tuner strip. It swaps instantly — no cross-fade, since a color transition on the one control that switches the palette would undercut the "no color, ever" rule everywhere else.

**Type**

Two families, no more:
- **Geist Sans** (400/500/600) — everything a person wrote or reads: messages, labels, the reasoning-off/on text
- **Geist Mono** — everything the system measured: model slug, tokens/sec, latency, timestamps, and the reasoning trace itself (see below). If it's a number or a process the model produced, it's mono; if it's authored content, it's Sans.

**Layout**

Centered column, 680px max-width — narrower than the 760–800px most chat UIs default to.

```
┌───────────────────────────────────────────┐
│ ≡   anthropic/claude-sonnet · 42 tok/s  ⚙  │  ← tuner strip, glass, sticky top
├───────────────────────────────────────────┤
│                                             │
│   assistant text, no bubble —              │
│   flows like reading, not chatting         │
│                                             │
│                         ╭──────────────╮   │
│                         │ user message │   │  ← glass pill, right-aligned only
│                         ╰──────────────╯   │
│                                             │
├───────────────────────────────────────────┤
│   ╭─────────────────────────────────╮  ↑  │  ← floating glass input, margin
│   ╰─────────────────────────────────╯     │     from viewport edge, not docked
└───────────────────────────────────────────┘
```

Assistant messages get no bubble or background — they read like text on a page. User messages are the only bubbles: right-aligned, glass pill, 14px radius. This asymmetry is deliberate, not an oversight.

**Signature interaction: the tuner strip**

The persistent bar at the top isn't a static header — it's the model switcher, styled as a channel/frequency readout rather than a dropdown. Tapping it opens a searchable list of every OpenRouter model; selecting one causes the strip to "settle" with a short, damped motion (~200ms, ease-out, slight overshoot-then-settle) — a filled block sweeping and inverting into place, like a VU meter needle rendered in silhouette rather than a UI panel sliding in. This is the one place motion gets to be a little expressive; everywhere else it stays quiet.

**Reasoning display**

A model's reasoning trace is telemetry, not content, and it's styled that way: Geist Mono, Muted gray, smaller size, in a panel above the final answer with a thin hairline down the left edge — like a margin note or a scan log, not a chat bubble. It streams in live as it arrives and is collapsed by default; the moment the final answer starts streaming, it auto-collapses further if the person had it open, so it never competes with the answer for attention. The answer itself stays Foreground / Geist Sans, full contrast, unchanged from a non-reasoning response. Same mono-for-measured, sans-for-authored split as the tuner strip's tokens/sec readout — the trace is just another gauge.

Reasoning is a three-state control in the input bar, next to send — **off · on · effort**, with effort expanding to low/medium/high when on. It's set as text labels in Mono, not an icon, consistent with the rest of the instrument language, and maps directly to OpenRouter's `reasoning.effort` parameter.

**Real-time search**

A second toggle, same location and treatment as reasoning: off/on, no effort levels. When on, the model decides when to search rather than searching on every turn. Sources the model actually used come back as small superscript Mono numbers inline in the answer, with a hairline-bordered block underneath listing title and domain for each — text only, no favicons, no card grid. Search has its own per-request cost separate from token cost; surface it in the same Mono readout style used for tokens/sec, since that's already how this app talks about cost.

**Motion, everywhere else**

- New messages: fade + 4px slide-up, 150ms ease-out
- Streaming text: opacity ramp per chunk, no blinking caret, no typewriter sound-alike stutter
- Reasoning trace: same opacity-ramp streaming, but at Muted contrast rather than Foreground
- Respect `prefers-reduced-motion` — the tuner-tick and message animation both degrade to a plain opacity fade

## Core features (v1)

- Streaming chat, one message thread at a time
- Model switcher — live OpenRouter catalog, searchable, shows pricing per model
- Conversation history — sidebar, stored in IndexedDB, rename/delete
- Markdown rendering + syntax-highlighted code blocks in assistant messages
- Copy message, regenerate response, edit-and-resend
- Per-conversation system prompt
- Reasoning toggle (off/low/medium/high) with the telemetry-style trace display
- Real-time search toggle with inline citations
- Keyboard-first: Cmd+Enter to send, Cmd+K to switch models

## Stretch (v2+)

- **Sub-agent delegation (exploratory).** The primary model hands off a sub-task to a different OpenRouter model via a tool call — e.g. delegate a narrow question to a cheaper/faster model, or to one better suited to it, while the main thread keeps going. The sub-agent's output streams into a nested, labeled block (model slug in Mono) inside the main thread rather than a separate window. This is the least-specified item here and genuinely more complex than everything else on this list — it gets its own design pass once the core product is solid, not a checkbox alongside the rest.
- Token/cost tracker per conversation, including search cost as its own line item (shown in the mono readout style — fits how you already think about metrics)
- Command palette (Cmd+K expanded beyond model switching)
- Export conversation as Markdown/JSON
- Vision input for multimodal models
- Prompt templates / saved system-prompt snippets
- BYOK-per-session (paste a key in-browser, never persisted) as an alternative to the env var, useful if this ever needs to run somewhere you don't control the server

## Non-goals (v1)

Explicitly out of scope until there's a real reason to revisit:

- Multi-user auth or accounts
- Server-side database / cross-device sync
- Billing or usage limits
- Open-ended agentic tool use beyond web search and (exploratory) model delegation — no file access, no code execution, no general browsing
- Voice input or output

## Architecture

```
/app
  /api/chat/route.ts        → POST, streams from OpenRouter via streamText
  /api/models/route.ts      → GET, cached OpenRouter model catalog
  layout.tsx
  page.tsx                  → main chat view
/components
  chat/
    MessageList.tsx
    MessageBubble.tsx
    ReasoningPanel.tsx       → collapsible telemetry-style trace
    Citations.tsx            → hairline footnote block for search sources
    InputBar.tsx             → send + reasoning/search toggles
  tuner/
    TunerStrip.tsx
    ThemeToggle.tsx
    ModelSwitcher.tsx
  sidebar/
    ConversationList.tsx
  ui/                        → restyled primitives (no default shadcn look)
/lib
  openrouter.ts              → createOpenRouter() wrapper: reasoning param, web_search tool, appName/appUrl
  db.ts                      → Dexie schema: conversations, messages
  types.ts
/styles
  globals.css                → design tokens as CSS custom properties
```

## Environment variables

```
OPENROUTER_API_KEY=
```

That's the only required one for v1. Nothing else needs a secret.

## Getting started

```bash
pnpm install
cp .env.example .env.local   # add OPENROUTER_API_KEY
pnpm dev
```

## Roadmap

- [ ] **Phase 0 — Scaffold.** Next.js project, Tailwind config with the design tokens above as CSS variables (both themes), folder structure.
- [ ] **Phase 1 — Core loop.** One hardcoded model, streaming end-to-end, no bubble styling yet — prove the plumbing works.
- [ ] **Phase 2 — Model switcher.** Live OpenRouter catalog, tuner strip UI, model persisted per conversation.
- [ ] **Phase 3 — Reasoning + search.** Reasoning toggle and telemetry-style trace panel, `openrouter:web_search` tool with inline citations.
- [ ] **Phase 4 — Persistence.** Dexie schema, conversation sidebar, rename/delete.
- [ ] **Phase 5 — Design pass.** Glass panels, motion, dark/light theme toggle, the tuner-tick signature interaction, mobile responsiveness.
- [ ] **Phase 6 — Stretch.** Pick from the list above based on what's actually missing once v1 is lived-in.

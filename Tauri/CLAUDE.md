# Chat desktop — project law for future sessions

The desktop app for chat.belayet.app, built with Tauri 2. It ships the
website's own UI, bundled, and talks to the same API. The UI lives in
`../web`; this project is everything native around it. Commands run from this
folder. The repository-wide rules are in `../CLAUDE.md`; the web side of the
contract is in `../web/CLAUDE.md`, "The desktop app".

## The decision this project rests on

**The UI is bundled, not loaded.** `npm run build` builds `../web` first
(`beforeBuildCommand`) and embeds its static export (`frontendDist:
../../web/out`); the window serves it from `tauri://localhost`
(`http://tauri.localhost` on Windows). The user chose this over loading the
live site (October 2026) after being told plainly that it does **not** save
memory — the same WebKit runs the same JavaScript either way. What it buys:

- the code that holds the vault key is the code in the installed app, not
  whatever a server sends on a given day;
- the window opens instantly, and without a network says so instead of going
  blank (the web app's "Can't reach the server" state);
- and it costs: UI changes reach the app with a new build, not a deploy
  (there is no updater yet — the user reinstalls), and the API had to accept
  a cross-origin caller.

Because the UI is on another origin than the API:

- **The Worker allows the app's origins** (CORS, never with credentials) and
  sign-in trusts them (`../web/worker/src/auth.ts`, `appOrigins`).
- **The session is a bearer token, kept in the macOS Keychain.** Better Auth's
  bearer plugin issues it; the UI stores and reads it through this app's
  commands (`session_token`, `set_session_token`, `clear_session_token`), never
  in web storage. The live socket carries it as a subprotocol.
- **OpenRouter connect happens in the default browser** and comes back through
  `belayet-chat://openrouter?code=…`, opened by a relay page on the website.
  The app holds the code until the UI takes it (`take_openrouter_code`).

## Stack (locked)

- **Tauri 2.12** (`tauri` 2.12.1, `tauri-build` 2.7.1, `@tauri-apps/cli`
  2.12.1, pinned exactly). Tauri 3 is in alpha; don't move until it is stable
  and the user approves.
- Plugins: `deep-link` (the `belayet-chat` scheme), `single-instance` (with
  `deep-link`: a second launch, or a link that starts one, goes to the running
  app), `window-state` (size and place), `opener` (links out, reveal
  downloads). **`keyring` 4** for the Keychain (Credential Manager on Windows).
- **Rust stable via rustup**, edition 2021. **npm** here (pnpm is not
  installed on the macOS box); `package-lock.json` is committed.
- **No frontend in this folder.** The UI is `../web`; nothing here renders.
- **Desktop only.** `crate-type = ["rlib"]`.

## Layout

- `src-tauri/src/lib.rs` — everything: the window, the desktop announcement,
  Keychain and deep-link commands, navigation and downloads, full-screen
  tracking, the macOS menu and close behaviour, and tests.
- `src-tauri/tauri.conf.json` — identity (`app.belayet.chat`), the web build,
  `withGlobalTauri`, the CSP, the deep-link scheme, bundle settings.
  `app.windows` is empty: the window is built in Rust.
- `src-tauri/tauri.local.conf.json` — the CSP for a build against the local
  Worker (`npm run dev:local`, below).
- `src-tauri/capabilities/default.json` — what the UI may call: event
  listen/unlisten, start dragging, toggle maximize, set theme, and the four app
  commands. Local content only. `build.rs` declares the app commands so they
  are behind this file rather than open by default.
- `assets/`, `scripts/icons.mjs`, `src-tauri/icons/` — icons (see Icons).

## How it works

- **`window.__CHAT_DESKTOP__`** (`{ api, platform }`) is defined by an
  initialization script before any page script runs. It is the only thing
  that switches the UI into desktop mode (`../web/lib/api.ts`), and the boot
  script turns `platform` into `data-shell` on the root element pre-paint.
- **`API`** is `https://chat.belayet.app`, or `CHAT_API` at compile time.
- **Navigation:** the window only ever shows the bundled UI. Everything else —
  the website included — goes to the default browser, and only as `http`,
  `https` or `mailto` (`may_open_outside`): a link in a model's answer must not
  launch an arbitrary URL handler. New windows always go out.
- **Downloads** go to Downloads under the page's suggested name (wry's path,
  numbered when taken) and are revealed when done.
- **The title bar is hidden on macOS** (`Overlay`, hidden title) and the
  traffic lights sit at `TRAFFIC_LIGHTS`, measured from the native buttons:
  14px lights from x 18 to 78, centred 32px from the top (tao centres them at
  `y − 2`). The UI centres its top rows on that line and reserves 90px
  (`--dial-lights-*` in `../web/app/globals.css`); change both together. In
  full screen macOS hides the lights and the app sets `data-fullscreen` so the
  UI drops the room — re-applied after a reload.
- **Theme:** the UI tells the window its theme (`setTheme`), so unfocused
  lights, context menus and the backdrop match it.
- **macOS:** standard menu bar plus View → Reload ⌘R, Back ⌘[, Forward ⌘].
  Closing the window hides it (a reply keeps streaming); the Dock or reopening
  shows it; Quit quits. The UI owns ⌘K, ⇧⌘K and ⌘B — never bind those.

## Rules learned the hard way

- **The CSP was the "WebKit bug".** A first probe on `tauri://localhost`
  showed `<img src="blob:…">`, XHR and `fetch(blob:)` all failing and looked
  like a custom-scheme limitation; it was the app's own CSP lacking `blob:`.
  With it, everything the UI uses works there: secure context, `crypto.subtle`,
  IndexedDB holding a non-extractable key, the Cache API, blob URLs. Probe with
  the real CSP before concluding the platform is at fault.
- **`dangerousDisableAssetCspModification` is on.** Tauri would otherwise add
  hashes to `script-src`/`style-src`, which switches `'unsafe-inline'` off —
  and the UI's inline style attributes (React, Motion) with it. The CSP mirrors
  `../web/public/_headers`, plus the API's origin and `ipc:`.
- **`beforeBuildCommand.cwd` is relative to `src-tauri/`**, not to this folder:
  `../../web`.
- **A Keychain item belongs to whoever made it.** One created with the
  `security` tool (even `-A`) made the app wait on a permission prompt; one the
  app creates itself is read back by the same build silently. An ad-hoc signed
  build is identified by its hash, so expect **a new build to ask once**
  ("Always Allow") for the item an older build made — not yet observed, since
  every test cleared the item first. A Developer ID signature would end that.
- **Timers in a window behind others are throttled.** A raw binary launched
  from a background process opens behind the frontmost app; tests then crawl.
  Launch a bundle with `open` to get the window in front.
- **Without a download handler, WebKit downloads are cancelled**, and on macOS
  a finished download reports no path — the destination is remembered from
  the start, keyed by URL.
- **wry asks the navigation handler about every frame.** Fine while the UI has
  no iframes; a cross-origin iframe would be sent to the browser on load.
- **Window state must not remember `VISIBLE` or `FULLSCREEN`**: closing only
  hides, so "hidden" would be saved; and the window is restored before it is
  shown. It is created hidden and shown after the restore, so it never jumps.
- **A full-screen window must not be ordered out** — that leaves a black
  Space; hiding the app takes the Space with it.
- **Background throttling is `Throttle`** (macOS 14+), so a hidden window's
  reply keeps streaming instead of being suspended.

## Verifying

- `npm test` — navigation, link, deep-link and announcement rules.
- `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` in
  `src-tauri/`.
- **Against the local Worker:** start it from `../web` with the app origins
  allowed (`npx wrangler dev --port 8787 --local`; they are built in), then
  `npm run dev:local`. Debug builds log every page load and title change.
- **The UI in desktop mode, in Chrome:** serve `../web/out` on another port
  with the app's CSP, define `__CHAT_DESKTOP__` and a stand-in `__TAURI__`
  before load, and run the Worker with `--var EXTRA_APP_ORIGINS:<that origin>`.
  That exercises CORS, bearer sessions, the socket, offline and the connect
  flow with real browser enforcement.
- **Natively,** build a debug bundle (`npm run tauri build -- --debug
  --bundles app`, with the local config), launch it with `open`, and drive it
  from a script the page evaluates — reporting through `document.title`,
  which the debug build logs. `__TAURI_INTERNALS__.invoke` is read-only, so
  record calls by making them, not by wrapping.

## Building and shipping

- `npm run build` → `src-tauri/target/release/bundle/macos/Chat.app` and
  `bundle/dmg/Chat_<version>_aarch64.dmg`, against chat.belayet.app.
- **Signed ad hoc, not notarized.** It runs on this Mac; another Mac needs
  right-click → Open the first time, or a Developer ID signature and
  notarization (`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or an API key).
- **Deep links register when the bundle is installed** (`CFBundleURLTypes`
  from the deep-link config). A debug bundle registers the same scheme; delete
  test bundles so links reach the installed app.
- **Windows** builds on the Windows box (Rust MSVC, `npm install`,
  `npm run build` → `.msi` and NSIS). Type-checked and linted for
  `x86_64-pc-windows-msvc` from macOS (with a stand-in `llvm-rc`), never built
  or run. The title bar stays native there.

## Icons

`assets/icon.svg` is the brand mark edge to edge (Windows, Linux);
`assets/icon-macos.svg` puts it on Apple's 1024 grid. `npm run icons` renders
both and keeps `icon.icns` from the second. If the mark changes in `../web`,
change both.

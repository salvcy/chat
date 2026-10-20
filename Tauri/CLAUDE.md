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
- **The session is a bearer token, kept in the system's credential store.**
  Better Auth's bearer plugin issues it; the UI stores and reads it through
  this app's commands (`session_token`, `set_session_token`,
  `clear_session_token`), never in web storage. The live socket carries it as
  a subprotocol. The store is the platform's own: the Keychain on macOS,
  Credential Manager on Windows, the Secret Service on Linux (GNOME Keyring,
  KWallet, KeePassXC — whatever answers on D-Bus). The item is named by the
  app's identifier, account `session`.
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
  downloads). **`keyring` 4** with its default `v1` feature for the credential
  store: Apple's Keychain, Windows' Credential Manager, and the Secret Service
  over pure-Rust D-Bus (`zbus`, no libdbus needed) on Linux.
- **Rust stable via rustup**, edition 2021. **npm** here (pnpm is not
  installed on the macOS box); `package-lock.json` is committed.
- **No frontend in this folder.** The UI is `../web`; nothing here renders.
- **Desktop only.** `crate-type = ["rlib"]`.

## Layout

- `src-tauri/src/lib.rs` — everything: the window and its life (closed,
  released, rebuilt), the desktop announcement, credential and deep-link
  commands, navigation and downloads, full-screen tracking, the macOS menu
  and close behaviour, and tests.
- `src-tauri/tauri.conf.json` — identity (`app.belayet.chat`), the web build,
  `withGlobalTauri`, the CSP, the deep-link scheme, bundle settings.
  `app.windows` is empty: the window is built in Rust.
- `src-tauri/tauri.local.conf.json` — a build against the local Worker
  (`npm run dev:local`, below): its CSP, and its own name and identifier
  ("Chat Local", `app.belayet.chat.local`), so it has its own credential item
  and its own web data and never touches the installed app's session.
- `src-tauri/capabilities/default.json` — what the UI may call: event
  listen/unlisten, start dragging, toggle maximize, and the six app commands
  (the theme goes through `set_window_theme`, not Tauri's own `setTheme`).
  Local content only. `build.rs` declares the app commands so they are
  behind this file rather than open by default.
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
  traffic lights **sit in the page's top rows**: from x 18, centred 32px from
  the top (`LIGHTS`; tao's inset is the centre plus 2), the line the UI
  centres New chat, the chat window's top strip and the front door's header
  on (`--dial-lights-x` / `--dial-lights-y` in `../web/app/globals.css` —
  change both sides together). The user asked for this over the 32px strip
  the window kept free above everything (October 2026). **They have to be
  put back**: AppKit returns moved buttons to its default place whenever it
  lays the title bar out — a new title, a new appearance, focus, a resize —
  and tao places them only when its own view draws, which none of those
  reliably cause. So after each of them, and after a page load, the app asks
  that view to draw (`macos::relight`): on the main thread, queued behind the
  change, and a draw follows the layout that moved them, so tao's placement
  is the one that holds. The UI sets the theme through `set_window_theme`
  (not Tauri's `setTheme`) so the app is told. The first version moved the
  lights relying on tao alone and they sat at the default height beside rows
  built for these; the second covered only the theme, and at a launch the
  lights were back at the default until a settings change sent the theme
  again (which of the others moved them was not pinned down — all are
  covered now). Debug builds log the lights' position after each relight
  (`chat: lights (…)`). In full
  screen macOS hides the lights and the app sets `data-fullscreen` so the
  UI drops the room — re-applied after a reload. The UI shows no brand mark
  in the app.
- **Theme:** the UI tells the window its theme (`set_window_theme`), so
  unfocused lights, context menus and the backdrop match it.
- **macOS:** standard menu bar plus View → Reload ⌘R, Back ⌘[, Forward ⌘].
  Closing the window hides it (a reply keeps streaming); the Dock or reopening
  shows it; Quit quits. The UI owns ⌘K, ⇧⌘K and ⌘B — never bind those. On
  Windows and Linux closing the window quits, as it does there.
- **A closed window gives its memory back.** A hidden window keeps its whole
  page — 314MB measured on a real account, 236MB of it WebKit's page
  process. So the window has a `Phase`: closing
  makes it `Closed` and tells the page (`window-closed`); five minutes later,
  if nothing is in flight, the page calls `release_window`
  (`../web/lib/release.ts` decides what "in flight" means), and the window is
  destroyed — `Released`, WebKit's page process exits (~55MB is left: the
  app and WebKit's GPU and network helpers), the app stays in the Dock because macOS's `ExitRequested` without a code is always refused (Quit
  never comes that way). The Dock, a second launch or a deep link builds a
  new window by the launch path: signed in from the credential store, the
  vault key from IndexedDB, the open thread from the account's settings —
  measured at ~0.3s. Only a closed window is released: not a minimised one,
  not a hidden app (switching back must find its window), not full screen.
  Release and reopen are both decided on the main thread; a reopen that lands
  while the old window is still going down is `Reopening`, built when the
  `Destroyed` event frees the label.

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
- **Keychain access follows the signature's Team ID, nothing less.** Every
  item an app creates carries a *partition*: `teamid:<ID>` when the app is
  signed with an Apple-issued certificate, otherwise `cdhash:<this exact
  build>`. Another build outside the partition gets a dialog asking for the
  login password. So an **ad-hoc build asks on every update**, and so does a
  **self-signed certificate** — tried, October 2026: its requirement was
  stable (`certificate leaf = H…`) but the partition was still the build's
  cdhash, and the test builds raised dialogs. Signed with the Mac's **Apple
  Development** certificate, a different build read and overwrote the items
  in ~4ms, no dialog (measured with two builds). There are two items: the
  session, and **WebKit's own WebCrypto master key** (account
  `com.apple.WebKit.WebCrypto.master+<identifier>`), which wraps the
  non-extractable vault key in IndexedDB — deny that one and the vault needs
  the password again ("Cannot store WebCrypto master key, error -25299").
- **A later build may be refused the delete.** Same certificate: in one test
  a build read and overwrote an item another build had made, then was refused
  deleting it ("Invalid attempt to change the owner of this item", −25244); in
  another the delete went through. `clear_session_token` therefore blanks the
  item when the delete is refused, and `session_token` reads blank as signed
  out.
- **Test without dialogs.** Don't let one binary read an item another made
  unless both share a Team ID: on this Mac that puts a dialog in front of the
  user. Between local builds of different signing, delete the *local*
  identifier's two items first (`security delete-generic-password -s
  app.belayet.chat.local -a session`, and `-a` the WebKit account). An item
  made with the `security` tool (even `-A`) is never the app's: it prompts.
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
  `npm run dev:local`. Debug builds log every page load, title change and
  release. The local build is "Chat Local" with its own identifier — it
  cannot sign the installed app out — but it registers the same
  `belayet-chat` scheme, so delete its bundle afterwards (and
  `lsregister -f /Applications/Chat.app`).
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
- **Signing.** `tauri.conf.json` says `-` (ad hoc), so any machine can
  build. On a Mac with an Apple certificate, a git-ignored
  `src-tauri/tauri.macos.conf.json` — which Tauri merges into every macOS
  build by itself — names it: `{"bundle":{"macOS":{"signingIdentity":"Apple
  Development: … (…)"}}}`. This Mac has one, so its builds carry Team ID
  `4TAY3RAX2T` and updates keep Keychain access (see "Keychain access follows
  the signature's Team ID"). The name holds across the certificate's yearly
  renewal (the requirement matches the subject name). It is not notarized: a
  build runs on the Mac that made it, another Mac needs right-click → Open
  the first time, or a Developer ID signature and notarization
  (`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or an API key).
- **Deep links register when the bundle is installed** (`CFBundleURLTypes`
  from the deep-link config). A debug bundle registers the same scheme; delete
  test bundles so links reach the installed app.
- **Windows** builds on the Windows box (Rust MSVC, `npm install`,
  `npm run build` → `.msi` and NSIS). Type-checked and linted for
  `x86_64-pc-windows-msvc` from macOS (with a stand-in `llvm-rc`), never built
  or run. The title bar stays native there; the installers register the
  scheme.
- **Linux** builds on Linux (Tauri's system packages: WebKitGTK 4.1, GTK 3,
  librsvg, OpenSSL dev headers; `npm run build` → `.deb`, `.rpm`, AppImage).
  Never built or run here — WebKitGTK cannot be cross-compiled from macOS.
  The UI is served from `tauri://localhost` as on macOS, so the Worker's
  origins already cover it. The `.deb` and `.rpm` register the scheme; an
  AppImage registers it itself at launch (`register_all`). The session needs
  a Secret Service on the session bus; without one, sign-in lasts until the
  app quits. Building all three on CI (a matrix of macOS, Windows and Ubuntu
  runners) is the way to verify the other two.

## Icons

`assets/icon.svg` is the brand mark — a slash in a squircle — edge to edge
(Windows, Linux); `assets/icon-macos.svg` puts the slash on Apple's 1024
grid, on Apple's own icon tile (continuous corners at its 185.4 radius) so it
sits with the rest of the Dock. `npm run icons` renders
both and keeps `icon.icns` from the second. If the mark changes in `../web`,
change both.

# Chat for the desktop

The desktop app for [chat.belayet.app](https://chat.belayet.app), built with
[Tauri 2](https://tauri.app). It ships the same interface as the website,
bundled into the app, and uses the same account: your conversations, settings
and encrypted vault are the ones you have on the web, and a reply streaming on
one device streams on the others.

What's different from the website:

- **It opens instantly**, and without a network it says so and waits instead
  of showing a blank window.
- **The code that holds your encryption key is the code you installed**, not
  whatever a server sends.
- **Your session lives in the macOS Keychain.**
- **A native window:** no title bar — the traffic lights sit in the app's own
  top row — a standard menu bar with Reload (⌘R), Back (⌘[) and Forward (⌘]),
  and closing the window hides it so a reply keeps streaming.
- **Links open in your browser.** Connecting OpenRouter happens there too, and
  your browser hands the key straight back to the app.
- Conversation exports and generated images save to Downloads and are shown
  in Finder (Explorer on Windows).

## Requirements

- [Node](https://nodejs.org) 20+, [Rust](https://rustup.rs) (stable), and
  `npm install` already run in `../web` (the build builds it).
- macOS: Xcode or its command-line tools.
- Windows: the Rust MSVC toolchain and the Visual Studio C++ build tools.

## Commands

```bash
npm install
npm run dev        # build ../web, open the app against chat.belayet.app
npm run dev:local  # the same against a local Worker on :8787
npm test           # unit tests for the native rules
npm run build      # release bundles
npm run icons      # regenerate src-tauri/icons from assets/
```

`npm run build` writes to `src-tauri/target/release/bundle/`:

- macOS — `macos/Chat.app` and `dmg/Chat_0.2.0_aarch64.dmg`
- Windows — `msi/` and `nsis/` installers

The macOS build is signed ad hoc, not notarized: it runs on the Mac that
built it; another Mac needs right-click → Open the first time. After
installing a newer build, expect macOS to ask once whether it may use the
session the old one saved — choose Always Allow.

Design decisions and their reasons are in [`CLAUDE.md`](CLAUDE.md).

# Chat

A minimal, end-to-end encrypted chat interface for every model on
OpenRouter. Two codebases, one product:

| Folder | What it is |
| --- | --- |
| [`web/`](web) | The app — a static Next.js export, and the Cloudflare Worker that serves it at [chat.belayet.app](https://chat.belayet.app) with accounts, sync and storage. |
| [`Tauri/`](Tauri) | The desktop app — Tauri 2, shipping the same UI built from `web/`, on the same account. |

The desktop app bundles a build of `web/`'s UI rather than loading the site,
so it opens instantly and the code holding your encryption key is the code you
installed; a UI change reaches it with the next app build. Each folder is a
separate project with its own dependencies: run its commands from inside it.

## Web

```bash
cd web
npm install
npm run dev
```

Building, the Worker, and deploying are in [`web/README.md`](web/README.md).

## Desktop

Needs [Rust](https://rustup.rs) and, on macOS, Xcode or its command-line tools.

```bash
cd Tauri
npm install
npm run dev     # builds web/, then opens the app against chat.belayet.app
npm run build   # Chat.app and a .dmg under src-tauri/target/release/bundle/
```

More in [`Tauri/README.md`](Tauri/README.md).

## Credits

The ASCII ocean — the sharks and fish swimming behind the sign-in screen and
the empty chat (`web/lib/ocean/`) — is from
[ascii-sharks](https://github.com/stackedlol/ascii-sharks) by
[stackedlol](https://github.com/stackedlol), adapted for this app's themes.
All credit for the simulation and the shark drawings goes to them.

## License

MIT — see [`LICENSE`](LICENSE). The files in `web/lib/ocean/` come from
ascii-sharks and remain its author's; the MIT license does not cover them.

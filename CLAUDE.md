# Repository map

Two separate projects, each with its own dependencies and its own law. Read the
one for the folder you are working in before changing anything there:

- **`web/`** — the product: Next.js static export + the Cloudflare Worker
  (`web/CLAUDE.md`, `web/ARCHITECTURE.md`). Every path in its docs is relative
  to `web/`, and every command runs from `web/` — including
  `npx wrangler deploy`, whose config is `web/wrangler.jsonc`.
- **`Tauri/`** — the desktop app: Tauri 2, bundling `web/`'s UI and talking
  to the same API across origins (`Tauri/CLAUDE.md`). Commands run from
  `Tauri/`; its build runs `web/`'s first.

The two were one folder until October 2026; the web project moved into `web/`
with its history intact (`git log --follow`).

Nothing at the root installs or builds anything, and there is deliberately no
root `package.json` or lockfile: Next.js picks its workspace root from the
lockfiles above it, and one here would make it treat the whole repository as
the workspace.

## Rules for the whole repository

- **Never commit `client_secret_*.json`.** It is ignored at every depth, by
  this folder's `.gitignore` and by `web/.gitignore`.
- **The user runs `wrangler secret put` themselves.** Never set a secret.
- **Never put the user's OpenRouter key in a field yourself, and never on
  disk.** That includes the desktop app's window, which runs the same UI.
- **Never change the salts** `"chat.belayet.co/vault/v1"` (`web/lib/crypto.ts`)
  and `"chat.belayet.co/auth/v1"` (`web/lib/auth-client.ts`). They are labels,
  not addresses; every existing credential and vault key was derived with
  them.
- **The two projects share a contract**, written down on both sides: the API
  origin, the app origins the Worker allows, the `belayet-chat` scheme and its
  relay page, the native command names, the title-bar strip and the
  CSP. The list is in `web/CLAUDE.md` under "The desktop app"; changing one
  side means changing the other.

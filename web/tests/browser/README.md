Run from `web/` with Playwright available and Google Chrome installed:

```sh
node tests/browser/background-navigation.mjs
```

If Playwright is provided by an external runtime, set `PLAYWRIGHT_MODULE` to
its `index.mjs` path. `PLAYWRIGHT_CHANNEL` defaults to `chrome`.

The test starts a separate Next dev server on port 3197 and creates a temporary
`/navigation-regression` route, removed when it exits. Run it without another
Next dev server using this checkout. It uses an isolated browser, synthetic
model responses, and a memory-only fake credential; no account, database, or
billable inference is used. It covers simultaneous requests, delayed history
loads, reopening a running chat, drafts, model isolation, hidden Escape,
pending and failed saves, retry, deletion, explicit Stop, and account teardown.

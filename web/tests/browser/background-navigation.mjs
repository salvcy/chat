// Run with: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/background-navigation.mjs
// Uses synthetic responses and an isolated browser; no account or model key needed.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const routeDir = new URL("../../app/navigation-regression/", import.meta.url);
let server, browser;
let createdRoute = false;
try {
  await mkdir(routeDir);
  createdRoute = true; // Refuse to overwrite an existing app route.
  await writeFile(new URL("page.tsx", routeDir), await readFile(new URL("background-navigation.fixture.tsx", import.meta.url)));
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--port", "3197"], {
    cwd: new URL("../../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  for (let i = 0; i < 90; i++) {
    if (logs.includes("Ready in")) break;
    if (server.exitCode !== null) throw new Error(logs);
    await delay(500);
  }
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const pending = [];
  const cancelled = [];
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("https://openrouter.ai/")) cancelled.push(request.postData() || "");
  });
  await page.route("https://openrouter.ai/**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*",
    } });
    pending.push(route);
  });
  const session = (id) => page.locator(`[data-chat-session="${id}"]`);
  const waitFor = async (check, label) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  };
  const open = (id) => page.getByRole("button", { name: `Open ${id}`, exact: true }).click();
  const send = async (id, text) => {
    await session(id).locator("textarea").fill(text);
    await session(id).locator("textarea").press("Enter");
    await waitFor(() => pending.some((route) => route.request().postDataJSON().messages.some((m) => JSON.stringify(m).includes(text))), text);
  };
  const finish = async (route, text) => {
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
      id: "test-response", object: "chat.completion.chunk", created: 1,
      model: route.request().postDataJSON().model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" },
      body: chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n" });
  };
  await page.goto("http://localhost:3197/navigation-regression");
  await send("a", "Question A");
  const requestA = pending.shift();
  await open("b");
  assert.equal(await session("a").count(), 1, "running A remains mounted");
  assert.equal(await session("a").isVisible(), false);
  await session("b").locator("textarea").fill("Unsent B draft");
  await open("a");
  assert.equal(await session("b").isVisible(), false);
  await open("b");
  assert.equal(await session("b").locator("textarea").inputValue(), "Unsent B draft");
  await send("b", "Question B");
  const requestB = pending.shift();
  assert.equal(requestA.request().postDataJSON().model, "openai/gpt-4.1");
  assert.equal(requestB.request().postDataJSON().model, "openai/gpt-4.1-mini");
  await open("c");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.navigationTest.block = true; });
  await finish(requestA, "Answer A complete");
  await waitFor(() => page.evaluate(() => window.navigationTest.release.length > 0), "final save blocked");
  assert.equal(await session("a").count(), 1, "pending saves retain A");
  assert.equal(await page.locator("[data-active]").textContent(), "c");
  await page.evaluate(() => {
    window.navigationTest.block = false;
    window.navigationTest.release.splice(0).forEach((resolve) => resolve());
  });
  await waitFor(async () => await session("a").count() === 0, "completed hidden A released");
  await page.evaluate(() => { window.navigationTest.fail = true; });
  await finish(requestB, "Answer B complete");
  await waitFor(() => session("b").getByText(/Test save failure/).count(), "failed save retained");
  assert.deepEqual(await page.evaluate(() => window.navigationTest.selections), [], "background finishes never navigate");
  await open("b");
  assert.ok((await session("b").textContent()).includes("Answer B complete"));
  await page.evaluate(() => { window.navigationTest.fail = false; });
  await session("b").getByRole("button", { name: "Retry", exact: true }).click();
  await waitFor(() => page.evaluate(() => window.navigationTest.saves.some((s) => s.id === "b" && !s.draft)), "retry saved B");
  await open("c");
  await waitFor(async () => await session("b").count() === 0, "saved hidden B released");
  const result = await page.evaluate(() => window.navigationTest);
  assert.deepEqual(result.selections, ["b"], "only the visible retry selects itself");
  for (const id of ["a", "b"]) {
    const saved = result.saves.findLast((entry) => entry.id === id && !entry.draft);
    assert.ok(saved, `${id} has a final save`);
    assert.ok(JSON.stringify(saved.messages).includes(`Answer ${id.toUpperCase()} complete`));
    assert.ok(!JSON.stringify(saved.messages).includes('"status":"interrupted"'));
  }
  assert.deepEqual(errors, [], "navigation and saves have no browser errors");
  await open("a");
  await send("a", "Delete running A");
  await open("c");
  await page.getByRole("button", { name: "Delete a", exact: true }).click();
  assert.equal(await session("a").count(), 0, "deleted session disposed");
  await waitFor(() => cancelled.some((body) => body.includes("Delete running A")), "deleted request cancelled");
  await send("c", "Explicit stop");
  await session("c").getByRole("button", { name: "Stop generating", exact: true }).click();
  await waitFor(() => session("c").getByText("Request was interrupted by the user.", { exact: true }).count(), "explicit stop still interrupts");
  await send("c", "Account teardown");
  await page.getByRole("button", { name: "Unmount account", exact: true }).click();
  assert.equal(await page.locator("[data-chat-session]").count(), 0, "account teardown disposes all sessions");
  await waitFor(() => cancelled.some((body) => body.includes("Account teardown")), "account request cancelled");
  // The SDK/provider may report an AbortError when explicitly stopping a
  // fetch before its headers arrive. Other uncaught errors are regressions.
  assert.ok(errors.every((message) => message === "signal is aborted without reason"), JSON.stringify(errors));
  console.log("PASS: concurrent requests, navigation, drafts, model isolation, hidden Escape, final saves, retry, deletion, explicit stop, and account teardown");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  if (createdRoute) {
    await rm(routeDir, { recursive: true, force: true });
    // Dev's generated validator otherwise keeps an import of the removed fixture.
    await rm(new URL("../../.next/dev/types/", import.meta.url), { recursive: true, force: true });
  }
}

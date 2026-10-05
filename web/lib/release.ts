"use client";

import { useEffect } from "react";
import { desktop, invokeDesktop, onDesktopEvent } from "./api";

/**
 * Letting the desktop app's page go while its window is closed.
 *
 * On macOS, closing the window only hides it, so a reply keeps streaming —
 * and the page keeps everything it holds: the UI's code, the open thread and
 * its images, WebKit's caches. Measured on the installed app: 314MB in all,
 * 236MB of it the page's own process, for a window nobody can see.
 *
 * So once the window has been closed for `RELEASE_AFTER_MS` with nothing in
 * flight, the page asks the app to let it go (`release_window`): the window
 * is destroyed, the page's process exits, and the app stays in the Dock with
 * WebKit's small GPU and network helpers — about 55MB measured.
 * Opening it again builds a fresh window from the bundled UI by the same
 * path as a launch — the session from the credential store, the vault key
 * from IndexedDB, the open thread from the account's settings.
 *
 * "In flight" is whatever a release would lose:
 *
 *  - a reply streaming or an image being made, a turn not yet saved or one
 *    whose save failed, attachments waiting in the composer — each held by
 *    the component that owns it (`useHoldPage`);
 *  - anything typed into any field and not sent — the composer, an edit, a
 *    sign-in form — read from the page itself, so a field added later is
 *    covered without anyone remembering this file.
 *
 * Only the app knows whether the window is closed rather than minimised,
 * covered or hidden with the app, and it refuses a release in any of those.
 * Outside the desktop app, and on platforms where closing the window quits,
 * none of this runs: the event never comes.
 */

const RELEASE_AFTER_MS = 5 * 60_000;
/** While something holds the page, how often to look again. */
const RECHECK_MS = 30_000;

const holds = new Set<symbol>();

/** Keep the page while `holding` — the release would lose what it covers. */
export function useHoldPage(holding: boolean): void {
  useEffect(() => {
    if (!holding) return;
    const hold = Symbol("hold");
    holds.add(hold);
    return () => {
      holds.delete(hold);
    };
  }, [holding]);
}

const TEXT_FIELDS = new Set(["text", "search", "email", "password", "url", "tel"]);

/** Whether any field on the page holds text that has not gone anywhere. */
function typedSomewhere(): boolean {
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input",
  )) {
    if (field instanceof HTMLInputElement && !TEXT_FIELDS.has(field.type)) continue;
    if (field.value.trim() !== "") return true;
  }
  return false;
}

/** Mounted once, at the root. */
export function useReleaseWhenClosed(): void {
  useEffect(() => {
    if (!desktop) return;
    let timer: number | undefined;
    const disarm = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const attempt = () => {
      if (holds.size > 0 || typedSomewhere()) {
        timer = window.setTimeout(attempt, RECHECK_MS);
        return;
      }
      timer = undefined;
      void invokeDesktop("release_window").catch(() => undefined);
    };
    const stop = onDesktopEvent("window-closed", () => {
      disarm();
      timer = window.setTimeout(attempt, RELEASE_AFTER_MS);
    });
    const onVisibility = () => {
      if (document.visibilityState === "visible") disarm();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      disarm();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

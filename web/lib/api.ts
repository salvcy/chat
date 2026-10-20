"use client";

/**
 * Where the API is, and how a request proves who sent it.
 *
 * On the web the app and its API share an origin: paths are relative and the
 * session is an httpOnly cookie the browser attaches by itself.
 *
 * The desktop app (`../Tauri`) ships its own copy of this UI and serves it
 * from inside the app (`tauri://localhost`), so the API is another origin.
 * Its native side announces itself before any script here runs, by defining
 * `window.__CHAT_DESKTOP__` — the API's origin and the platform — and that
 * definition is the only thing that switches this module into desktop mode.
 * There:
 *
 *  - every path is absolute, against `desktop.api`;
 *  - the session travels as `Authorization: Bearer`, because a same-site
 *    cookie is never sent across origins. The token arrives in a
 *    `set-auth-token` header (Better Auth's bearer plugin) and lives in the
 *    system's credential store — the Keychain, Credential Manager, the
 *    Secret Service — read and written through the app's own commands, never
 *    in web storage, where any script in the page could read it;
 *  - the live socket offers the token as a subprotocol (`openLiveSocket`).
 *
 * Read `desktop` in effects and handlers only, never during render: the
 * static export is prerendered where `window` does not exist, and a render
 * that differed by mode would not hydrate.
 */

type Desktop = { api: string; platform: string };

type TauriGlobal = {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void>;
  };
};

declare global {
  interface Window {
    __CHAT_DESKTOP__?: Desktop;
    __TAURI__?: TauriGlobal;
  }
}

export const desktop: Desktop | null =
  typeof window === "undefined" ? null : (window.__CHAT_DESKTOP__ ?? null);

function tauri(): TauriGlobal | null {
  return desktop ? (window.__TAURI__ ?? null) : null;
}

/** An API path as a URL this page can fetch. */
export function apiUrl(path: string): string {
  return desktop ? `${desktop.api}${path}` : path;
}

/**
 * The site's public address: OpenRouter attribution, and the page OpenRouter
 * returns to. `tauri://localhost` means nothing outside the app.
 */
export function siteOrigin(): string {
  return desktop?.api ?? window.location.origin;
}

/** The request never reached the server — no network, or the server is down. */
export class OfflineError extends Error {
  constructor() {
    super("can't reach the server — check your connection");
    this.name = "OfflineError";
  }
}

/* ------------------------------ the session ----------------------------- */

let token: string | null = null;
let loaded: Promise<void> | null = null;

/** Read the credential store once per run; every request after that uses memory. */
function loadToken(): Promise<void> {
  loaded ??= (async () => {
    try {
      token = (await tauri()?.core.invoke<string | null>("session_token")) ?? null;
    } catch {
      token = null;
    }
  })();
  return loaded;
}

async function keepToken(next: string | null): Promise<void> {
  if (next === token) return;
  token = next;
  try {
    if (next) await tauri()?.core.invoke("set_session_token", { token: next });
    else await tauri()?.core.invoke("clear_session_token");
  } catch {
    // Still held in memory, so this run stays signed in; the next launch asks
    // for the password again. That is every launch on a Linux desktop with
    // no Secret Service running.
  }
}

/** Forget the desktop session: signing out, deleting the account, or a dead token. */
export async function forgetSession(): Promise<void> {
  if (!desktop) return;
  await loadToken();
  await keepToken(null);
}

/** Whether a request would carry a session — the cookie is invisible, so true on the web. */
export async function hasSession(): Promise<boolean> {
  if (!desktop) return true;
  await loadToken();
  return token !== null;
}

/**
 * `fetch` for this app's API: the right origin, the right credential, and the
 * session token kept when the server issues one. Throws `OfflineError` when
 * the request could not be made at all.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  if (!desktop) {
    try {
      response = await fetch(path, { ...init, credentials: "same-origin" });
    } catch {
      throw new OfflineError();
    }
    return response;
  }

  await loadToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  try {
    response = await fetch(apiUrl(path), { ...init, headers, credentials: "omit" });
  } catch {
    throw new OfflineError();
  }
  const issued = response.headers.get("set-auth-token");
  if (issued) await keepToken(issued);
  return response;
}

/**
 * The account's live socket. The website's carries its cookie; the desktop
 * app's offers `chat.v1` plus its token, base64url'd so it is a valid
 * subprotocol token (worker/src/index.ts, LIVE_PROTOCOL). Only called once
 * signed in, by which time the token has been read.
 */
export function openLiveSocket(query: string): WebSocket {
  if (!desktop) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(`${protocol}//${window.location.host}/v1/live?${query}`);
  }
  const url = new URL(`/v1/live?${query}`, desktop.api);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (!token) return new WebSocket(url);
  const encoded = btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return new WebSocket(url, ["chat.v1", `bearer.${encoded}`]);
}

/* ----------------------------- the native side ---------------------------- */

/** One of the app's own commands (src-tauri/src/lib.rs). Null on the web. */
export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const native = tauri();
  return native ? native.core.invoke<T>(command, args) : null;
}

/** Listen for an event the native side emits. A no-op on the web. */
export function onDesktopEvent(name: string, handler: () => void): () => void {
  const native = tauri();
  if (!native) return () => undefined;
  let stop: (() => void) | null = null;
  let stopped = false;
  void native.event
    .listen(name, () => handler())
    .then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    });
  return () => {
    stopped = true;
    stop?.();
  };
}

/**
 * Match the window to the app's theme, so the native parts — the traffic
 * lights when unfocused, context menus, the window behind the page while it
 * resizes — agree with it. `system` hands the choice back to macOS.
 *
 * The app's own command rather than Tauri's `setTheme`: macOS moves the
 * traffic lights back to their default place when the window's appearance
 * changes, so the app sets the theme and then puts them back in the page's
 * top row (`set_window_theme` in Tauri/src-tauri/src/lib.rs).
 */
export function syncWindowTheme(theme: "light" | "dark" | "system"): void {
  void tauri()
    ?.core.invoke("set_window_theme", { theme: theme === "system" ? null : theme })
    .catch(() => undefined);
}

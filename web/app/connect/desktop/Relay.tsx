"use client";

import { useEffect, useSyncExternalStore } from "react";
import FrontDoor, { GateCard } from "@/components/settings/FrontDoor";
import { buttonClass } from "@/components/ui/Button";
import Loader from "@/components/ui/Loader";
import { DESKTOP_SCHEME } from "@/lib/pkce";

/**
 * The code, read once as the page loads — before the address bar is cleaned
 * below, and before anything else could rewrite it. Null during prerender.
 */
const code =
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("code");

/** The app's URL for this code: `belayet-chat://openrouter?code=…`. */
const target = code
  ? `${DESKTOP_SCHEME}://openrouter?code=${encodeURIComponent(code)}`
  : null;

const subscribe = () => () => undefined;

export default function Relay() {
  // `undefined` while hydrating (the server had no URL), then the target or
  // null — read through the store API so the two renders never mismatch.
  const link = useSyncExternalStore(
    subscribe,
    () => target,
    () => undefined,
  );

  useEffect(() => {
    if (!target) return;
    // The code is single-use: out of the address bar and history, so a
    // reload cannot replay it.
    window.history.replaceState(null, "", window.location.pathname);
    window.location.href = target;
  }, []);

  return (
    <FrontDoor>
      <GateCard className="max-w-[400px]">
        <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-foreground">
          {link === null ? "Nothing to hand back" : "Returning to Chat"}
        </h1>
        {link === null ? (
          <p className="mt-1 text-[13px] leading-relaxed text-secondary">
            This page passes an OpenRouter connection to the Chat app, and there
            isn’t one here. Start again from the app.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[13px] leading-relaxed text-secondary">
              Your browser will ask to open Chat. Once the app shows your key
              as connected, you can close this tab.
            </p>
            {link ? (
              <a href={link} className={buttonClass("primary", "md", "mt-6 w-full")}>
                Open Chat
              </a>
            ) : (
              <Loader timer={false} className="mt-6" />
            )}
          </>
        )}
      </GateCard>
    </FrontDoor>
  );
}

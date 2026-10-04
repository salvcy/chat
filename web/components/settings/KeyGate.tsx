"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Loader from "@/components/ui/Loader";
import { GateCard } from "./FrontDoor";
import { fetchKeyStatus } from "@/lib/account";
import { desktop, onDesktopEvent } from "@/lib/api";
import {
  looksLikeKey,
  type Credential,
  type CredentialSource,
} from "@/lib/credentials";
import {
  ConnectError,
  beginConnect,
  clearCodeFromUrl,
  completeConnect,
  pendingCode,
  takeDesktopCode,
} from "@/lib/pkce";

/**
 * The connect screen — the app's front door now that there is no operator
 * key behind it.
 *
 * Two paths, deliberately in this order:
 *
 *  - **Connect** runs OAuth PKCE. The user authorizes on openrouter.ai and
 *    comes back with a key scoped to this app, revocable on its own and
 *    capable of carrying its own credit limit. Nobody handles a raw secret.
 *  - **Paste** exists because the first path can fail in ways we don't
 *    control (a code that expired, a tab that lost its verifier, a
 *    restrictive browser) and being locked out of your own chat history by
 *    an OAuth hiccup is not acceptable.
 *
 * The key is validated against OpenRouter before it is stored, so a typo
 * fails here with a reason rather than three screens later as a mystery
 * stream error.
 *
 * In the desktop app, Connect opens the default browser and this screen waits;
 * the code comes back through the app's URL scheme (see `lib/pkce.ts`).
 */
/** Trade an authorization code for a verified key, or say why not. */
async function exchange(
  code: string,
): Promise<{ credential: Credential } | { error: string }> {
  try {
    const credential = await completeConnect(code);
    const status = await fetchKeyStatus(credential.key);
    return { credential: { ...credential, label: status.label } };
  } catch (err) {
    return {
      error:
        err instanceof ConnectError || err instanceof Error
          ? err.message
          : "the connection could not be completed",
    };
  }
}

export default function KeyGate({
  onConnect,
  signedIn,
  encrypted,
}: {
  onConnect: (credential: Credential) => void;
  /** Changes what this screen can truthfully promise about the key. */
  signedIn: boolean;
  encrypted: boolean;
}) {
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True while finishing an OAuth round trip, so the form isn't offered. */
  const [returning, setReturning] = useState(() => pendingCode() !== null);
  /** Desktop only: approval is happening in the browser. */
  const [waiting, setWaiting] = useState(false);

  /* --------------------------- oauth return --------------------------- */

  useEffect(() => {
    const code = pendingCode();
    if (!code) return;
    // Consume it immediately: codes are single-use, so a re-render or a
    // reload must not be able to spend the same one twice.
    clearCodeFromUrl();

    let cancelled = false;
    void (async () => {
      const result = await exchange(code);
      if (cancelled) return;
      if ("error" in result) setError(result.error);
      else onConnect(result.credential);
      setReturning(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [onConnect]);

  // The desktop app's way back: the native side announces a code, and also
  // holds one that arrived before this screen was listening.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    const claim = async () => {
      const code = await takeDesktopCode();
      if (!code || cancelled) return;
      setReturning(true);
      setWaiting(false);
      const result = await exchange(code);
      if (cancelled) return;
      if ("error" in result) setError(result.error);
      else onConnect(result.credential);
      setReturning(false);
    };
    void claim();
    const stop = onDesktopEvent("openrouter-code", () => void claim());
    return () => {
      cancelled = true;
      stop();
    };
  }, [onConnect]);

  /* ------------------------------ actions ------------------------------ */

  const startOauth = async () => {
    setError(null);
    setBusy(true);
    try {
      await beginConnect();
      if (desktop) {
        setBusy(false);
        setWaiting(true);
      }
      // On the web beginConnect navigates away; reaching here means it didn't.
    } catch {
      setBusy(false);
      setError("could not start the connection — paste a key instead");
    }
  };

  const submitManual = async () => {
    const key = manual.trim();
    if (!key) return;
    if (!looksLikeKey(key)) {
      setError("that does not look like an OpenRouter key (sk-or-v1-…)");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      // Verify before storing — a bad key should fail here, with a reason.
      const status = await fetchKeyStatus(key);
      onConnect({
        key,
        source: "manual" satisfies CredentialSource,
        label: status.label,
        connectedAt: Date.now(),
      });
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error
          ? err.message === "OpenRouter rejected this key."
            ? "OpenRouter rejected that key"
            : err.message
          : "the key could not be verified",
      );
    }
  };

  /* ------------------------------- render ------------------------------ */

  return (
    <GateCard className="max-w-[400px]">
      <span className="flex size-9 items-center justify-center rounded-card bg-field shadow-hairline">
        <svg viewBox="0 0 16 16" className="h-4 w-4 text-secondary" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="5.5" cy="10.5" r="2.75" />
          <path d="m7.5 8.5 5.25-5.25M11 5l1.75 1.75M9.5 6.5l1.25 1.25" />
        </svg>
      </span>
      <h1 className="mt-4 text-[19px] font-semibold tracking-[-0.02em] text-foreground">
        {returning ? "Connecting to OpenRouter" : "Connect your OpenRouter key"}
      </h1>
      <p className="mt-1 text-[13px] leading-relaxed text-secondary">
        Requests go from this device straight to OpenRouter — no server of ours
        sits in the path.{" "}
        {signedIn
          ? encrypted
            ? "The key is saved to your account, encrypted with your password so we cannot read it."
            : "The key is saved to your account so it follows you between devices."
          : "The key stays on this device."}
      </p>

      {returning ? (
        <Loader label="Finishing the handshake" className="mt-6" />
      ) : waiting ? (
        <div className="mt-6">
          <Loader label="Waiting for your browser" />
          <p className="mt-3 text-[12.5px] leading-relaxed text-secondary">
            Approve on openrouter.ai, and the key comes straight back to this
            window.
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => setWaiting(false)}
            className="mt-4 w-full"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <Button
            variant="primary"
            size="md"
            onClick={() => void startOauth()}
            disabled={busy}
            className="mt-6 w-full"
          >
            Connect with OpenRouter
            <span aria-hidden className="opacity-60">→</span>
          </Button>

          <div className="mt-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11px] text-muted">or paste a key</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <form
            className="mt-5 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitManual();
            }}
          >
            <input
              type="password"
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                setError(null);
              }}
              placeholder="sk-or-v1-…"
              aria-label="OpenRouter API key"
              autoComplete="off"
              spellCheck={false}
              className="dial-input min-w-0 flex-1 font-mono text-[12.5px]!"
            />
            <Button
              type="submit"
              variant="secondary"
              size="md"
              disabled={busy || !manual.trim()}
            >
              Use key
            </Button>
          </form>
        </>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-control bg-hover px-3 py-2 text-[12.5px] leading-relaxed text-foreground"
          style={{ animation: "dial-fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          {error}
        </p>
      )}

      <p className="mt-5 border-t border-line pt-4 text-[11.5px] leading-relaxed text-muted">
        {signedIn
          ? "Signed in — your history syncs to your account. "
          : "History stays in this browser. "}
        Manage keys at{" "}
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono text-secondary transition-colors hover:text-foreground"
        >
          <span className="dial-underline">openrouter.ai/keys</span>
        </a>
      </p>
    </GateCard>
  );
}

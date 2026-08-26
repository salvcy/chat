"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { fetchKeyStatus } from "@/lib/account";
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
 */
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

  /* --------------------------- oauth return --------------------------- */

  useEffect(() => {
    const code = pendingCode();
    if (!code) return;
    // Consume it immediately: codes are single-use, so a re-render or a
    // reload must not be able to spend the same one twice.
    clearCodeFromUrl();

    let cancelled = false;
    void (async () => {
      try {
        const credential = await completeConnect(code);
        const status = await fetchKeyStatus(credential.key);
        if (cancelled) return;
        onConnect({ ...credential, label: status.label });
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ConnectError || err instanceof Error
            ? err.message
            : "the connection could not be completed",
        );
      } finally {
        if (!cancelled) setReturning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onConnect]);

  /* ------------------------------ actions ------------------------------ */

  const startOauth = async () => {
    setError(null);
    setBusy(true);
    try {
      await beginConnect();
      // beginConnect navigates away; reaching here means it didn't.
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
    <div className="flex flex-1 items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="w-full max-w-[420px]"
      >
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {returning ? "connecting" : "openrouter"}
        </p>
        <h1 className="mt-2 text-[15px] leading-relaxed text-foreground">
          Connect your OpenRouter key to start.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-secondary">
          Requests go from this browser straight to OpenRouter — no server of
          ours sits in the path.{" "}
          {signedIn
            ? encrypted
              ? "The key is saved to your account, encrypted with your password so we cannot read it."
              : "The key is saved to your account so it follows you between devices."
            : "The key stays on this device."}
        </p>

        {returning ? (
          <p className="mt-6 font-mono text-xs text-muted">
            finishing the handshake…
          </p>
        ) : (
          <>
            <button
              onClick={() => void startOauth()}
              disabled={busy}
              className="mt-6 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Connect with OpenRouter
            </button>

            <div className="mt-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-hairline" />
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted">
                or paste one
              </span>
              <span className="h-px flex-1 bg-hairline" />
            </div>

            <div className="mt-4 flex gap-2">
              <input
                type="password"
                value={manual}
                onChange={(e) => {
                  setManual(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitManual();
                }}
                placeholder="sk-or-v1-…"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-full border border-hairline bg-surface px-3.5 py-2 font-mono text-xs text-foreground placeholder:text-muted focus:outline-none"
              />
              <button
                onClick={() => void submitManual()}
                disabled={busy || !manual.trim()}
                className="shrink-0 rounded-full border border-hairline px-3.5 py-2 font-mono text-[11px] text-secondary transition-colors hover:border-hairline-strong hover:text-foreground disabled:opacity-40"
              >
                use
              </button>
            </div>
          </>
        )}

        {error && (
          <p className="mt-4 font-mono text-[11px] leading-relaxed text-foreground">
            {error}
          </p>
        )}

        <p className="mt-8 font-mono text-[10px] leading-relaxed text-muted">
          {signedIn
            ? "signed in · history syncs to your account · "
            : "history stays in this browser · "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-hairline underline-offset-2 transition-colors hover:text-foreground"
          >
            openrouter.ai/keys
          </a>
        </p>
      </motion.div>
    </div>
  );
}

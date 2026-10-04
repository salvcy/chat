"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { GateCard } from "./FrontDoor";

/**
 * Shown when someone is signed in but this device cannot read their history.
 *
 * The situation is specific and worth naming precisely: the session cookie
 * lasts thirty days and is httpOnly, while the key that decrypts the account
 * lives in IndexedDB. Clearing site data — or any browser cleanup that
 * spares cookies — leaves a person authenticated and locked out of their own
 * conversations.
 *
 * Without this they would see an empty transcript and reasonably conclude
 * their history was gone. It is not: it is sitting on the server as
 * ciphertext, and their password is the only thing that opens it.
 */
export default function UnlockBar({
  email,
  rememberDeviceKey,
  onUnlock,
}: {
  email: string;
  rememberDeviceKey: boolean;
  onUnlock: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(password);
      setPassword("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "that password did not work",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <GateCard>
      <span className="flex size-9 items-center justify-center rounded-card bg-field shadow-hairline">
        <svg viewBox="0 0 16 16" className="h-4 w-4 text-secondary" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="7" width="10" height="7" rx="1.75" />
          <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
        </svg>
      </span>
      <h1 className="mt-4 text-[19px] font-semibold tracking-[-0.02em] text-foreground">
        Unlock your conversations
      </h1>
      <p className="mt-1 text-[13px] leading-relaxed text-secondary">
        Your history is safe in the cloud as ciphertext. Enter the password for{" "}
        <span className="text-foreground">{email}</span> to open it here.
      </p>

      <form
        className="mt-6 space-y-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          placeholder="Password"
          autoComplete="current-password"
          aria-label={`Password for ${email}`}
          autoFocus
          className="dial-input"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!password || busy}
          className="w-full"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-control bg-hover px-3 py-2 text-[12.5px] leading-relaxed text-foreground"
          style={{ animation: "dial-fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          {error}
        </p>
      )}

      <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-[11.5px] leading-relaxed text-muted">
        <span
          aria-hidden="true"
          className={`mt-[5px] size-1.5 shrink-0 rounded-full ${
            rememberDeviceKey ? "bg-foreground" : "border border-foreground"
          }`}
        />
        <span>
          {rememberDeviceKey
            ? "This browser will keep a non-exportable unlock key after you sign in."
            : "High privacy is on — this browser locks again after a refresh."}{" "}
          You can change this in settings.
        </span>
      </p>
    </GateCard>
  );
}

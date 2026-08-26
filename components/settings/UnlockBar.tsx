"use client";

import { useState } from "react";
import { motion } from "motion/react";

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
  onUnlock,
}: {
  email: string;
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
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="shrink-0 border-b border-hairline bg-surface px-4 py-3 sm:px-7"
    >
      <div className="dial-column flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            locked on this device
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-secondary">
            Your conversations are encrypted and this browser no longer has the
            key. Enter your password to unlock them — nothing has been lost.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Password"
            autoComplete="current-password"
            aria-label={`Password for ${email}`}
            className="w-44 rounded-full border border-hairline bg-background px-3.5 py-1.5 text-[12px] text-foreground placeholder:text-muted focus:outline-none"
          />
          <button
            onClick={() => void submit()}
            disabled={!password || busy}
            className="shrink-0 rounded-full bg-foreground px-3.5 py-1.5 font-mono text-[10px] text-background transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            {busy ? "unlocking…" : "unlock"}
          </button>
        </div>
      </div>

      {error && (
        <p className="dial-column mt-2 font-mono text-[10px] text-foreground">
          {error}
        </p>
      )}
    </motion.div>
  );
}
